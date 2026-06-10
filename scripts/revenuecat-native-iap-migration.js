#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const { Client } = require("@elastic/elasticsearch");
const { google } = require("googleapis");
const {
  Environment,
  SignedDataVerifier,
} = require("@apple/app-store-server-library");

const JOB_NAME = "SyncRevenueCatSubscriptionsToNativeIap";
const PROJECT_ROOT = path.resolve(__dirname, "..");
const MEMBER_INDEX = "members";
const MEMBER_MIGRATION_INDEX = "members-migration";
const SYSTEM_CONFIG_INDEX = "system_configs";
const SCROLL_KEEP_ALIVE = "2m";
const BATCH_SIZE = 999;
const DEFAULT_ANDROID_PACKAGE_NAME = "com.bessoga.reelike.android";

process.chdir(PROJECT_ROOT);

let envContext = null;

async function main() {
  envContext = loadEnvContext();
  const runtime = createRuntime();
  let scrollId;

  console.log(`[${JOB_NAME}] Starting`);
  console.log(
    `[${JOB_NAME}] Config ${JSON.stringify({
      memberIndex: MEMBER_INDEX,
      migrationIndex: MEMBER_MIGRATION_INDEX,
      batchSize: BATCH_SIZE,
      scriptEnv: envContext.name,
      migrationTag: runtime.migrationTag,
      writeMode: "members-migration",
      envFile: envContext.file,
      appleEnv: runtime.appleEnv,
      androidPackageName: runtime.androidPackageName,
    })}`
  );

  // Step 1: Load tier mapping so RevenueCat/native product ids can map back to member tier.
  if (process.env.MERCHANT_ID) {
    try {
      const systemConfig = await runtime.esClient.get({
        index: SYSTEM_CONFIG_INDEX,
        id: process.env.MERCHANT_ID,
      });
      runtime.memberTiers = systemConfig?._source?.member_tiers || {};
    } catch (error) {
      console.error(
        `[${JOB_NAME}] Failed to fetch member_tiers`,
        serializeError(error)
      );
    }
  } else {
    console.log(`[${JOB_NAME}] MERCHANT_ID is missing, tier update will be skipped`);
  }

  try {
    // Step 2: Scroll active members that still have a subscription_plan value.
    const firstPage = await runtime.esClient.search({
      index: MEMBER_INDEX,
      scroll: SCROLL_KEEP_ALIVE,
      size: BATCH_SIZE,
      body: {
        query: {
          bool: {
            filter: [
              { term: { active: true } },
              { term: { is_transferred: false } },
              { exists: { field: "subscription_plan" } },
            ],
            must_not: [{ term: { "subscription_plan.keyword": "" } }],
          },
        },
      },
    });

    scrollId = firstPage._scroll_id;
    let hits = firstPage.hits?.hits || [];

    while (hits.length > 0) {
      for (const hit of hits) {
        const memberSource = hit._source || {};
        const member = {
          _id: hit._id,
          source: memberSource,
          member_id: memberSource.member_id,
          subscription_plan: memberSource.subscription_plan,
          tier: memberSource.tier,
        };
        const memberLabel = member.member_id || member._id;
        runtime.summary.scanned++;

        try {
          // Step 3: Keep every RevenueCat subscription payload; skip native, miniapp, and one-time items.
          const parsed = parseRevenueCatSubscriptionPlan(member.subscription_plan);
          if (!parsed.ok) {
            runtime.summary.skipped++;
            console.log(
              `[${JOB_NAME}] member=${memberLabel} status=skipped ${JSON.stringify({
                reason: parsed.reason,
              })}`
            );
            continue;
          }

          // Step 4: Check latest subscription state directly from Apple or Google.
          const nativePlan = await buildNativePlan(
            runtime,
            parsed.platform,
            parsed.event
          );

          // Step 5: Log only the exact member fields that would be stored in DB.
          const updateData = buildUpdateData(runtime, nativePlan);

          runtime.summary.mapped++;
          runtime.summary.by_platform[parsed.platform]++;
          console.log(`${JOB_NAME}.updateMember`, JSON.stringify(updateData));

          // Stage 2 draft: after log validation, uncomment this block to copy
          // the full member document into members-migration without touching members.
          // The old values stay in ref_* fields for rollback tracing.
          const migrationDocument = buildMigrationDocument(
            member,
            updateData,
            new Date().toISOString(),
            runtime.migrationTag
          );
          await runtime.esClient.index({
            index: MEMBER_MIGRATION_INDEX,
            id: member._id,
            document: migrationDocument,
          });

          // Stage 3 draft: final update back into the real members index.
          // Keep this commented until logs and members-migration documents are verified.
          // await runtime.esClient.update({
          //   index: MEMBER_INDEX,
          //   id: member._id,
          //   doc: {
          //     ...updateData,
          //     updated_at: new Date().toISOString(),
          //   },
          // });
        } catch (error) {
          runtime.summary.errors++;
          console.log(
            `[${JOB_NAME}] member=${memberLabel} status=error ${JSON.stringify(
              serializeError(error)
            )}`
          );
        }
      }

      if (!scrollId) {
        break;
      }

      // Step 6: Fetch the next scroll page until there are no more members.
      const nextPage = await runtime.esClient.scroll({
        scroll_id: scrollId,
        scroll: SCROLL_KEEP_ALIVE,
      });
      scrollId = nextPage._scroll_id;
      hits = nextPage.hits?.hits || [];
    }
  } finally {
    if (scrollId) {
      // Step 7: Always clear the Elasticsearch scroll context.
      await runtime.esClient.clearScroll({ scroll_id: scrollId }).catch((error) => {
        console.error(`[${JOB_NAME}] Failed to clear scroll`, serializeError(error));
      });
    }
  }

  console.log(
    `[${JOB_NAME}] Completed ${JSON.stringify(runtime.summary, null, 2)}`
  );
}

function createRuntime() {
  const esClient =
    process.env.ELASTICSEARCH_CLOUD_ID && process.env.ELASTICSEARCH_API_KEY
      ? new Client({
          requestTimeout: 300000,
          maxRetries: 3,
          cloud: { id: requiredEnv("ELASTICSEARCH_CLOUD_ID") },
          auth: { apiKey: requiredEnv("ELASTICSEARCH_API_KEY") },
        })
      : new Client({
          requestTimeout: 300000,
          maxRetries: 3,
          node: requiredEnv("ELASTICSEARCH_HOST"),
        });
  const summary = {
    scanned: 0,
    skipped: 0,
    mapped: 0,
    errors: 0,
    by_platform: {
      ios: 0,
      android: 0,
    },
  };
  let appleContext = null;
  let androidPublisher = null;

  return {
    esClient,
    summary,
    migrationTag: buildDateTimeTag(new Date()),
    memberTiers: {},
    appleEnv: process.env.APPLE_ENV || "PRODUCTION",
    androidPackageName:
      process.env.ANDROID_PACKAGE_NAME || DEFAULT_ANDROID_PACKAGE_NAME,
    getAppleContext() {
      const shouldCreateToken =
        !appleContext || appleContext.tokenExpiresAtMs < Date.now() + 60_000;
      if (!shouldCreateToken) {
        return appleContext;
      }

      const environmentName =
        this.appleEnv === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
      const environment =
        environmentName === "PRODUCTION"
          ? Environment.PRODUCTION
          : Environment.SANDBOX;
      const baseUrl =
        environmentName === "PRODUCTION"
          ? "https://api.storekit.apple.com"
          : "https://api.storekit-sandbox.apple.com";
      const bundleId = requiredEnv("APPLE_BUNDLE_ID");
      const appAppleId =
        environmentName === "PRODUCTION"
          ? Number(requiredEnv("APPLE_APPLE_ID"))
          : undefined;

      if (appAppleId !== undefined && !Number.isFinite(appAppleId)) {
        throw new Error("APPLE_APPLE_ID must be a number");
      }

      const privateKey = fs.readFileSync(
        resolvePath(requiredEnv("APPLE_PRIVATE_KEY_PATH")),
        "utf8"
      );
      const rootCert = fs.readFileSync(
        resolvePath(requiredEnv("APPLE_ROOT_CERT_PATH"))
      );
      const verifier = new SignedDataVerifier(
        [rootCert],
        process.env.APPLE_ENABLE_ONLINE_CHECKS?.toLowerCase() === "true",
        environment,
        bundleId,
        appAppleId
      );
      const now = Math.floor(Date.now() / 1000);
      const expiresInSeconds = 20 * 60;
      const token = jwt.sign(
        {
          iss: requiredEnv("APPLE_ISSUER_ID"),
          iat: now,
          exp: now + expiresInSeconds,
          aud: "appstoreconnect-v1",
          bid: bundleId,
        },
        privateKey,
        {
          algorithm: "ES256",
          header: {
            alg: "ES256",
            kid: requiredEnv("APPLE_KEY_ID"),
            typ: "JWT",
          },
        }
      );

      appleContext = {
        baseUrl,
        environmentName,
        jwt: token,
        tokenExpiresAtMs: (now + expiresInSeconds) * 1000,
        verifier,
      };

      return appleContext;
    },
    getAndroidPublisher() {
      if (androidPublisher) {
        return androidPublisher;
      }

      const serviceAccountPath = resolvePath(
        requiredEnv("ANDROID_SERVICE_ACCOUNT_PATH")
      );
      if (!fs.existsSync(serviceAccountPath)) {
        throw new Error(`Service account file not found: ${serviceAccountPath}`);
      }

      const auth = new google.auth.GoogleAuth({
        keyFile: serviceAccountPath,
        scopes: ["https://www.googleapis.com/auth/androidpublisher"],
      });
      androidPublisher = google.androidpublisher({ version: "v3", auth });

      return androidPublisher;
    },
  };
}

// Load the requested env file before creating any external clients.
// Commands choose the env explicitly, for example:
// sync:revenuecat-native:uat -> .env.uat, sync:revenuecat-native:prod -> .env.prod.
function loadEnvContext() {
  const requestedEnv = normalizeScriptEnv(
    getArgValue("--env") ||
      process.env.SCRIPT_ENV ||
      process.env.MIGRATION_ENV ||
      "uat"
  );
  const explicitEnvFile = getArgValue("--env-file") || process.env.ENV_FILE;
  const envFile = explicitEnvFile || `.env.${requestedEnv}`;
  const envPath = resolveProjectPath(envFile);

  if (path.basename(envPath) === ".env") {
    throw new Error("Plain .env is not supported. Use .env.uat or .env.prod.");
  }

  if (!fs.existsSync(envPath)) {
    throw new Error(
      `Env file not found: ${envPath}. Create it from .env.example first.`
    );
  }

  const result = dotenv.config({ path: envPath, override: true });
  if (result.error) {
    throw result.error;
  }

  return {
    name: requestedEnv,
    file: path.relative(PROJECT_ROOT, envPath),
  };
}

function getArgValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));

  return arg ? arg.slice(prefix.length) : null;
}

function normalizeScriptEnv(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  const aliases = {
    develop: "uat",
    development: "uat",
    local: "uat",
    sandbox: "uat",
    production: "prod",
  };

  return aliases[normalized] || normalized || "uat";
}

// Parse only the RevenueCat shapes we want to migrate; everything else returns a skip reason.
function parseRevenueCatSubscriptionPlan(subscriptionPlan) {
  let plan;

  try {
    plan =
      typeof subscriptionPlan === "string"
        ? JSON.parse(subscriptionPlan)
        : subscriptionPlan;
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${error.message}` };
  }

  const revenueCatType = String(plan?.type || "")
    .toLowerCase()
    .includes("revenue");
  const event =
    plan?.event ||
    plan?.data?.event ||
    (revenueCatType && plan?.data ? plan.data : null) ||
    plan;

  if (!event || typeof event !== "object") {
    return { ok: false, reason: "subscription_plan is not an object" };
  }

  if (plan?.type === "native-iap" || event?.type === "native-iap") {
    return { ok: false, reason: "already native-iap" };
  }

  if (event.content || event.tier_id || event.data?.subscription) {
    return { ok: false, reason: "miniapp subscription shape" };
  }

  const eventType = String(event.type || "").toUpperCase();
  const productId = String(event.new_product_id || event.product_id || "");
  const productCandidates = [
    event.new_product_id,
    event.product_id,
    event.entitlement_id,
    ...(Array.isArray(event.entitlement_ids) ? event.entitlement_ids : []),
  ];
  const transactionId = String(
    event.original_transaction_id || event.transaction_id || ""
  );
  const hasRevenueCatSource =
    revenueCatType ||
    String(plan?.source || plan?.provider || "")
      .toLowerCase()
      .includes("revenue") ||
    !!plan?.api_version ||
    !!plan?.event;
  const hasRevenueCatFields =
    !!event.store &&
    !!transactionId &&
    !!(
      event.product_id ||
      event.new_product_id ||
      event.entitlement_id ||
      event.entitlement_ids
    );
  const hasEntitlement =
    !!event.entitlement_id ||
    (Array.isArray(event.entitlement_ids) && event.entitlement_ids.length > 0);
  const looksLikeSubscription =
    eventType !== "NON_RENEWING_PURCHASE" &&
    !!(
      event.expiration_at_ms ||
      event.original_transaction_id ||
      hasEntitlement ||
      /^(vip|vvip)([_-]|$)/i.test(productId.split(":").pop() || "")
    );

  if (
    eventType === "NON_RENEWING_PURCHASE" ||
    productCandidates.some(isOneTimeProductId)
  ) {
    return { ok: false, reason: "RevenueCat event is one-time purchase" };
  }

  if (!hasRevenueCatSource && !hasRevenueCatFields) {
    return { ok: false, reason: "not RevenueCat subscription shape" };
  }

  if (!looksLikeSubscription) {
    return { ok: false, reason: "RevenueCat event is not subscription" };
  }

  const store = String(event.store || "").toUpperCase();
  const platform = ["APP_STORE", "MAC_APP_STORE"].includes(store)
    ? "ios"
    : ["PLAY_STORE", "GOOGLE_PLAY"].includes(store)
      ? "android"
      : transactionId.startsWith("GPA.")
        ? "android"
        : /^\d+$/.test(transactionId)
          ? "ios"
          : String(event.platform || "").toLowerCase();

  if (!["ios", "android"].includes(platform)) {
    return { ok: false, reason: `unsupported store: ${event.store || "unknown"}` };
  }

  return {
    ok: true,
    event,
    platform,
  };
}

function isOneTimeProductId(value) {
  const normalizedValue = normalizeIapTierId(value);

  return /(^|-)one-?time($|-)/.test(normalizedValue);
}

// Build the same native-iap payload shape used by the existing iOS/Android scripts.
async function buildNativePlan(runtime, platform, event) {
  if (platform === "ios") {
    const apple = runtime.getAppleContext();
    const originalTransactionId = String(
      event.original_transaction_id || event.transaction_id || ""
    ).trim();

    if (!originalTransactionId) {
      throw new Error("RevenueCat iOS event missing original_transaction_id");
    }

    const response = await axios.get(
      `${apple.baseUrl}/inApps/v1/subscriptions/${originalTransactionId}`,
      {
        headers: { Authorization: `Bearer ${apple.jwt}` },
        timeout: 15000,
      }
    );
    const statusResponse = response.data;
    const groups = Array.isArray(statusResponse?.data) ? statusResponse.data : [];
    const transactionGroups = groups.map((group) =>
      Array.isArray(group?.lastTransactions) ? group.lastTransactions : []
    );
    const matchingGroup =
      transactionGroups.find((transactions) =>
        transactions.some(
          (item) => item?.originalTransactionId === originalTransactionId
        )
      ) ||
      transactionGroups.find((transactions) => transactions.length > 0) ||
      [];
    const latestTransaction =
      matchingGroup.find((item) => item?.status === 1) ||
      matchingGroup.find(
        (item) => item?.originalTransactionId === originalTransactionId
      ) ||
      matchingGroup[0] ||
      null;
    const verifiedTransaction = latestTransaction?.signedTransactionInfo
      ? await apple.verifier.verifyAndDecodeTransaction(
          latestTransaction.signedTransactionInfo
        )
      : null;
    const verifiedRenewalInfo = latestTransaction?.signedRenewalInfo
      ? await apple.verifier.verifyAndDecodeRenewalInfo(
          latestTransaction.signedRenewalInfo
        )
      : null;

    if (!verifiedTransaction) {
      throw new Error("Apple subscription response has no verified transaction");
    }

    return {
      statusResponse,
      latestTransaction,
      verifiedTransaction,
      verifiedRenewalInfo,
      summary: {
        status: latestTransaction?.status ?? null,
        statusLabel:
          {
            1: "ACTIVE",
            2: "EXPIRED",
            3: "BILLING_RETRY",
            4: "BILLING_GRACE_PERIOD",
            5: "REVOKED",
          }[latestTransaction?.status] || "UNKNOWN",
        originalTransactionId:
          latestTransaction?.originalTransactionId?.trim() ||
          verifiedTransaction?.originalTransactionId?.trim() ||
          null,
        productId: verifiedTransaction?.productId?.trim() || null,
        autoRenewProductId:
          verifiedRenewalInfo?.autoRenewProductId?.trim() || null,
        expiresDate: numberOrNull(verifiedTransaction?.expiresDate),
        gracePeriodExpiresDate: numberOrNull(
          verifiedRenewalInfo?.gracePeriodExpiresDate
        ),
        renewalDate: numberOrNull(verifiedRenewalInfo?.renewalDate),
        autoRenewStatus: verifiedRenewalInfo?.autoRenewStatus ?? null,
        appAccountToken:
          verifiedRenewalInfo?.appAccountToken?.trim() ||
          verifiedTransaction?.appAccountToken?.trim() ||
          null,
        environment:
          verifiedRenewalInfo?.environment?.trim() ||
          verifiedTransaction?.environment?.trim() ||
          null,
      },
      type: "native-iap",
      platform: "ios",
    };
  }

  const publisher = runtime.getAndroidPublisher();
  const packageName = runtime.androidPackageName.trim();
  const orderId = String(
    event.original_transaction_id || event.transaction_id || ""
  ).trim();
  const webhookProductId = String(
    event.new_product_id || event.product_id || ""
  ).trim();
  const [fallbackProductId, fallbackBasePlanId = null] =
    webhookProductId.split(":");
  let orderResponse = null;
  let purchaseToken = String(event.purchase_token || event.purchaseToken || "").trim();

  if (!packageName) {
    throw new Error("Missing Android package name");
  }

  if (!purchaseToken) {
    if (!orderId) {
      throw new Error("RevenueCat Android event missing order id and purchase token");
    }

    orderResponse = (
      await publisher.orders.get({
        packageName,
        orderId,
      })
    ).data;
    purchaseToken = orderResponse?.purchaseToken || "";
  }

  if (!purchaseToken) {
    throw new Error("Google order response has no purchaseToken");
  }

  const response = await publisher.purchases.subscriptionsv2.get({
    packageName,
    token: purchaseToken,
  });
  const googleResponse = response.data;
  const lineItem = Array.isArray(googleResponse.lineItems)
    ? googleResponse.lineItems[0]
    : null;
  const orderLineItem = Array.isArray(orderResponse?.lineItems)
    ? orderResponse.lineItems[0]
    : null;
  const productId =
    lineItem?.productId || orderLineItem?.productId || fallbackProductId || "";
  const basePlanId =
    lineItem?.offerDetails?.basePlanId ||
    orderLineItem?.subscriptionDetails?.basePlanId ||
    fallbackBasePlanId;
  const expiresDate = lineItem?.expiryTime
    ? new Date(lineItem.expiryTime).getTime()
    : null;
  const isAutoRenewEnabled = !!lineItem?.autoRenewingPlan?.autoRenewEnabled;
  const isExpired =
    googleResponse.subscriptionState === "SUBSCRIPTION_STATE_ACTIVE" &&
    typeof expiresDate === "number" &&
    expiresDate < Date.now();
  const validGoogleStates = [
    "SUBSCRIPTION_STATE_UNSPECIFIED",
    "SUBSCRIPTION_STATE_PENDING",
    "SUBSCRIPTION_STATE_ACTIVE",
    "SUBSCRIPTION_STATE_PAUSED",
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
    "SUBSCRIPTION_STATE_ON_HOLD",
    "SUBSCRIPTION_STATE_CANCELED",
    "SUBSCRIPTION_STATE_EXPIRED",
  ];
  const statusLabel = isExpired
    ? "SUBSCRIPTION_STATE_EXPIRED"
    : validGoogleStates.includes(googleResponse.subscriptionState)
      ? googleResponse.subscriptionState
      : "UNKNOWN";

  return {
    verifiedTransaction: {
      transactionId: purchaseToken,
      productId,
      purchaseDate: googleResponse.startTime
        ? new Date(googleResponse.startTime).getTime()
        : undefined,
      type: "Auto-Renewable Subscription",
      purchaseToken,
      storefrontId: googleResponse.regionCode ?? undefined,
    },
    summary: {
      status:
        googleResponse.subscriptionState === "SUBSCRIPTION_STATE_ACTIVE" &&
        !isExpired
          ? 1
          : 0,
      statusLabel,
      purchaseToken,
      productId,
      basePlanId,
      autoRenewProductId: isAutoRenewEnabled ? productId : "",
      expiresDate,
      gracePeriodExpiresDate: null,
      renewalDate: expiresDate,
      autoRenewStatus: isAutoRenewEnabled ? 1 : 0,
      appAccountToken: null,
      environment: googleResponse.testPurchase ? "Sandbox" : "Production",
    },
    type: "native-iap",
    platform: "android",
  };
}

// Update tier only from the active native subscription returned by Apple/Google.
function buildUpdateData(runtime, nativePlan) {
  const updateData = {};
  const resolvedTier = resolveActiveNativePlanTier(runtime, nativePlan);

  if (resolvedTier) {
    updateData.tier = resolvedTier;
  }

  updateData.subscription_plan = JSON.stringify(nativePlan);

  return updateData;
}

function resolveActiveNativePlanTier(runtime, nativePlan) {
  if (!isNativePlanActive(nativePlan)) {
    return null;
  }

  return resolveTierFromCandidates(
    runtime.memberTiers,
    getNativePlanTierCandidates(nativePlan)
  );
}

function isNativePlanActive(nativePlan) {
  const summary = nativePlan?.summary || {};
  const statusLabel = String(summary.statusLabel || "").toUpperCase();

  return summary.status === 1 || statusLabel === "ACTIVE";
}

function getNativePlanTierCandidates(nativePlan) {
  const summary = nativePlan?.summary || {};

  if (nativePlan?.platform === "android") {
    return [
      summary.basePlanId,
      summary.productId,
      summary.autoRenewProductId,
    ];
  }

  return [
    summary.productId,
    summary.autoRenewProductId,
  ];
}

function resolveTierFromCandidates(memberTiers, candidates) {
  const tierPriority = {};
  const normalizedTierLabels = {};
  let priority = 0;
  for (const [key, config] of Object.entries(memberTiers || {})) {
    if (config?.label) {
      tierPriority[config.label] = priority++;
      normalizedTierLabels[normalizeIapTierId(key)] = config.label;
      normalizedTierLabels[normalizeIapTierId(config.label)] = config.label;
    }
  }

  let resolvedTier = null;
  let resolvedPriority = -1;
  for (const candidate of candidates.filter(Boolean)) {
    const rawValue = String(candidate).trim();
    const normalizedValue = normalizeIapTierId(rawValue);
    const matchedTier =
      memberTiers?.[rawValue]?.label ||
      memberTiers?.[normalizedValue]?.label ||
      (tierPriority[rawValue] !== undefined ? rawValue : null) ||
      (tierPriority[normalizedValue] !== undefined ? normalizedValue : null) ||
      resolveTierByPrefix(normalizedTierLabels, normalizedValue);

    if (matchedTier && tierPriority[matchedTier] > resolvedPriority) {
      resolvedTier = matchedTier;
      resolvedPriority = tierPriority[matchedTier];
    }
  }

  return resolvedTier;
}

function resolveTierByPrefix(normalizedTierLabels, normalizedValue) {
  const match = Object.entries(normalizedTierLabels).find(
    ([normalizedTierId]) => normalizedValue.startsWith(normalizedTierId)
  );

  return match?.[1] || null;
}

function buildMigrationDocument(member, updateData, syncDate, tag) {
  return {
    ...member.source,
    ...updateData,
    ref_tier: member.tier ?? null,
    ref_subscription_plan: member.subscription_plan ?? null,
    sync_date: syncDate,
    tag,
  };
}

function buildDateTimeTag(date) {
  const value = date instanceof Date ? date : new Date(date);
  const pad = (number) => String(number).padStart(2, "0");
  const datePart = [
    value.getFullYear(),
    pad(value.getMonth() + 1),
    pad(value.getDate()),
  ].join("");
  const timePart = [
    pad(value.getHours()),
    pad(value.getMinutes()),
    pad(value.getSeconds()),
  ].join("");

  return `${datePart}-${timePart}`;
}

function normalizeIapTierId(value) {
  const productSegment = String(value || "").split(":").pop() || "";
  return productSegment.toLowerCase().replace(/_/g, "-");
}

function serializeError(error) {
  return {
    status:
      error.response?.status || error.code || error.meta?.statusCode || null,
    data: error.response?.data || error.errors || error.meta?.body || null,
    message: error.message || "Unknown error",
  };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }

  return value;
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : resolveProjectPath(filePath);
}

function resolveProjectPath(filePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(PROJECT_ROOT, filePath);
}

main().catch((error) => {
  console.error(
    `[${JOB_NAME}] Failed`,
    JSON.stringify(serializeError(error), null, 2)
  );
  process.exit(1);
});
