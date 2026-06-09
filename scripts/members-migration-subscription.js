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

const JOB_NAME = "ValidateMembersMigrationSubscription";
const PROJECT_ROOT = path.resolve(__dirname, "..");
const MEMBER_MIGRATION_INDEX = "members-migration";
const SCROLL_KEEP_ALIVE = "2m";
const BATCH_SIZE = 100;
const EXPIRES_DATE_TOLERANCE_MS = 2_000;
const DEFAULT_ANDROID_PACKAGE_NAME = "com.bessoga.reelike.android";

process.chdir(PROJECT_ROOT);

async function main() {
  loadEnvContext();
  const runtime = createRuntime();

  await runValidation(runtime);
  logSummary(runtime.summary);
}

async function runValidation(runtime) {
  let scrollId;

  try {
    const firstPage = await searchMigrationMembers(runtime);

    scrollId = firstPage._scroll_id;
    let hits = getPageHits(firstPage);

    while (hits.length > 0) {
      await processMigrationBatch(runtime, hits);

      if (!scrollId) {
        break;
      }

      const nextPage = await scrollMigrationMembers(runtime, scrollId);
      scrollId = nextPage._scroll_id;
      hits = getPageHits(nextPage);
    }
  } finally {
    await clearMigrationScroll(runtime, scrollId);
  }
}

async function searchMigrationMembers(runtime) {
  return runtime.esClient.search({
    index: MEMBER_MIGRATION_INDEX,
    scroll: SCROLL_KEEP_ALIVE,
    size: BATCH_SIZE,
    _source: [
      "member_id",
      "tier",
      "ref_tier",
      "subscription_plan",
      "ref_subscription_plan",
      "sync_date",
    ],
    body: {
      query: {
        bool: {
          filter: [
            { exists: { field: "subscription_plan" } },
            { exists: { field: "ref_subscription_plan" } },
          ],
          must_not: [
            { term: { "subscription_plan.keyword": "" } },
            { term: { "ref_subscription_plan.keyword": "" } },
          ],
        },
      },
    },
  });
}

async function scrollMigrationMembers(runtime, scrollId) {
  return runtime.esClient.scroll({
    scroll_id: scrollId,
    scroll: SCROLL_KEEP_ALIVE,
  });
}

async function clearMigrationScroll(runtime, scrollId) {
  if (!scrollId) {
    return;
  }

  await runtime.esClient.clearScroll({ scroll_id: scrollId }).catch((error) => {
    logMemberResult({
      member: null,
      result: "error",
      error: serializeError(error),
    });
  });
}

function getPageHits(page) {
  return page.hits?.hits || [];
}

async function processMigrationBatch(runtime, hits) {
  for (const hit of hits) {
    await processMigrationMember(runtime, hit);
  }
}

async function processMigrationMember(runtime, hit) {
  runtime.summary.scanned++;

  const member = normalizeMigrationHit(hit);
  const memberLabel = member.member_id || member._id;

  try {
    const subscriptionPair = parseMigrationSubscriptionPair(member);
    const skipReason = getSubscriptionSkipReason(subscriptionPair);

    if (skipReason) {
      logMemberResult({
        member: memberLabel,
        result: "skipped",
        reason: skipReason,
      });
      return;
    }

    await validateSubscriptionPair(runtime, memberLabel, subscriptionPair);
  } catch (error) {
    logMemberResult({
      member: memberLabel,
      result: "error",
      error: serializeError(error),
    });
  }
}

function normalizeMigrationHit(hit) {
  return {
    _id: hit._id,
    ...(hit._source || {}),
  };
}

function parseMigrationSubscriptionPair(member) {
  return {
    native: getNativeIapSubscriptionFromMemberInfo(member.subscription_plan),
    revenueCat: getRevenueCatSubscriptionFromMemberInfo(
      member.ref_subscription_plan
    ),
  };
}

function getSubscriptionSkipReason(subscriptionPair) {
  if (!subscriptionPair.native.isNativeIap) {
    return "subscription_plan is not native-iap";
  }

  if (!subscriptionPair.revenueCat.isRevenueCat) {
    return "ref_subscription_plan is not RevenueCat";
  }

  return null;
}

async function validateSubscriptionPair(runtime, memberLabel, subscriptionPair) {
  runtime.summary.checked++;

  const comparison = compareSubscriptionResults(
    subscriptionPair.native.value,
    subscriptionPair.revenueCat.value
  );

  if (comparison.isMatch) {
    recordMemberMatch(
      runtime,
      memberLabel,
      "match",
      subscriptionPair.native.value
    );
    return;
  }

  await resolveMismatchWithRevenueInquiry(
    runtime,
    memberLabel,
    subscriptionPair
  );
}

async function resolveMismatchWithRevenueInquiry(
  runtime,
  memberLabel,
  subscriptionPair
) {
  const inquiryComparison = await compareWithRevenueCatInquiry(
    runtime,
    subscriptionPair.native.value,
    subscriptionPair.revenueCat
  );

  if (inquiryComparison.status === "match") {
    recordMemberMatch(
      runtime,
      memberLabel,
      "match-after-inquiry",
      subscriptionPair.native.value
    );
    return;
  }

  runtime.summary.mismatched++;

  if (inquiryComparison.status === "mismatch") {
    logMemberResult({
      member: memberLabel,
      result: "mismatch-after-revenue-inquiry",
      diff: inquiryComparison.diff,
    });
    return;
  }

  logMemberResult({
    member: memberLabel,
    result: `revenue-inquiry-${inquiryComparison.status}`,
    reason: inquiryComparison.reason,
    error: inquiryComparison.error,
  });
}

function recordMemberMatch(runtime, memberLabel, result, subscriptionResult) {
  runtime.summary.matched++;
  logMemberResult({
    member: memberLabel,
    result,
    is_active: subscriptionResult?.isActive === true,
  });
}

function createRuntime() {
  return {
    esClient: createElasticsearchClient(),
    summary: createSummary(),
    appleEnv: process.env.APPLE_ENV || "PRODUCTION",
    androidPackageName:
      process.env.ANDROID_PACKAGE_NAME || DEFAULT_ANDROID_PACKAGE_NAME,
    getAppleContext: createAppleContextGetter(),
    getAndroidPublisher: createAndroidPublisherGetter(),
  };
}

function createElasticsearchClient() {
  if (process.env.ELASTICSEARCH_CLOUD_ID && process.env.ELASTICSEARCH_API_KEY) {
    return new Client({
      requestTimeout: 300000,
      maxRetries: 3,
      cloud: { id: requiredEnv("ELASTICSEARCH_CLOUD_ID") },
      auth: { apiKey: requiredEnv("ELASTICSEARCH_API_KEY") },
    });
  }

  return new Client({
    requestTimeout: 300000,
    maxRetries: 3,
    node: requiredEnv("ELASTICSEARCH_HOST"),
  });
}

function createSummary() {
  return {
    scanned: 0,
    checked: 0,
    matched: 0,
    mismatched: 0,
  };
}

function createAppleContextGetter() {
  let appleContext = null;

  return function getAppleContext() {
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
  };
}

function createAndroidPublisherGetter() {
  let androidPublisher = null;

  return function getAndroidPublisher() {
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
  };
}

function logMemberResult(payload) {
  const logPayload = { ...payload };

  if (logPayload.diff && Object.keys(logPayload.diff).length === 0) {
    delete logPayload.diff;
  }

  console.log(`${JOB_NAME}.result`, JSON.stringify(logPayload));
}

function logSummary(summary) {
  console.log(`${JOB_NAME}.summary`, JSON.stringify(buildSummaryLog(summary)));
}

// This mirrors the native-iap part used by get member info.
function getNativeIapSubscriptionFromMemberInfo(subscriptionPlan) {
  const plan = parseJsonValue(subscriptionPlan);
  if (plan?.type !== "native-iap") {
    return {
      isNativeIap: false,
      value: emptySubscriptionResult("No subscription plan data"),
    };
  }

  return {
    isNativeIap: true,
    value: parseNativeIapSubscriptionPlan(plan),
  };
}

// This mirrors the RevenueCat subscription parsing used by get member info,
// with the same wrapper tolerance used by the migration script.
function getRevenueCatSubscriptionFromMemberInfo(refSubscriptionPlan) {
  const plan = parseJsonValue(refSubscriptionPlan);
  const event = getRevenueCatEvent(plan);

  if (!event) {
    return {
      isRevenueCat: false,
      value: emptySubscriptionResult("No subscription plan data"),
    };
  }

  return {
    isRevenueCat: true,
    event,
    platform: getRevenueCatPlatform(event),
    value: parseRevenueCatSubscriptionPlan(event),
  };
}

function parseNativeIapSubscriptionPlan(plan) {
  const summary = plan.summary || {};
  const entitlementId =
    plan.platform === "android"
      ? normalizeIapProductId(summary.basePlanId)
      : normalizeIapProductId(summary.productId);
  const expiresDateValue = summary.expiresDate;

  if (!expiresDateValue) {
    return {
      isActive: false,
      entitlementId,
      expiresDate: null,
      message: "No subscription plan data",
    };
  }

  const expiresDate = new Date(expiresDateValue);
  const expiresTime = expiresDate.getTime();

  if (Number.isNaN(expiresTime)) {
    return {
      isActive: false,
      entitlementId,
      expiresDate: null,
      message: "Invalid native IAP expiresDate",
    };
  }

  const state = resolveStoreSubscriptionState(summary, expiresTime);

  if (state === "expired") {
    return {
      isActive: false,
      entitlementId,
      expiresDate: expiresDate.toISOString(),
      message: "Subscription expired",
    };
  }

  return {
    isActive: true,
    entitlementId,
    expiresDate: expiresDate.toISOString(),
    message: "Active subscription found",
  };
}

function parseRevenueCatSubscriptionPlan(event) {
  const entitlementId =
    normalizeIapProductId(event.new_product_id) ||
    normalizeIapProductId(event.entitlement_ids?.[0]) ||
    normalizeIapProductId(event.entitlement_id) ||
    normalizeIapProductId(event.product_id);
  const now = Date.now();

  if (event.type === "EXPIRATION") {
    return {
      isActive: false,
      entitlementId,
      expiresDate: event.expiration_at_ms
        ? new Date(event.expiration_at_ms).toISOString()
        : null,
      message: "Subscription expired",
    };
  }

  if (event.expiration_at_ms) {
    if (event.expiration_at_ms > now) {
      return {
        isActive: true,
        entitlementId,
        expiresDate: new Date(event.expiration_at_ms).toISOString(),
        message: "Active subscription found",
      };
    }

    return {
      isActive: false,
      entitlementId,
      expiresDate: new Date(event.expiration_at_ms).toISOString(),
      message: "Subscription expired",
    };
  }

  if (event.type !== "CANCELLATION") {
    return {
      isActive: true,
      entitlementId,
      expiresDate: null,
      message: "Lifetime access found",
    };
  }

  return {
    isActive: false,
    entitlementId,
    expiresDate: null,
    message: "Subscription inactive",
  };
}

function compareSubscriptionResults(
  nativeResult,
  revenueCatResult,
  rightLabel = "revenue_cat"
) {
  const normalizedNative = normalizeSubscriptionResult(nativeResult);
  const normalizedRevenueCat = normalizeSubscriptionResult(revenueCatResult);
  const diff = {};

  for (const field of ["isActive", "entitlementId"]) {
    if (normalizedNative[field] !== normalizedRevenueCat[field]) {
      diff[field] = {
        native_iap: normalizedNative[field],
        [rightLabel]: normalizedRevenueCat[field],
      };
    }
  }

  if (
    !isDateWithinTolerance(
      normalizedNative.expiresDate,
      normalizedRevenueCat.expiresDate
    )
  ) {
    diff.expiresDate = {
      native_iap: normalizedNative.expiresDate,
      [rightLabel]: normalizedRevenueCat.expiresDate,
    };
  }

  return {
    isMatch: Object.keys(diff).length === 0,
    diff,
  };
}

async function compareWithRevenueCatInquiry(runtime, nativeResult, revenueCatResult) {
  if (!revenueCatResult.event) {
    return {
      status: "skipped",
      reason: "RevenueCat event not found",
    };
  }

  const platform =
    revenueCatResult.platform || getRevenueCatPlatform(revenueCatResult.event);

  if (!["ios", "android"].includes(platform)) {
    return {
      status: "skipped",
      reason: "unsupported RevenueCat store",
      platform: platform || "unknown",
    };
  }

  try {
    const refreshedNativePlan = await buildNativePlanFromRevenueCatEvent(
      runtime,
      platform,
      revenueCatResult.event
    );
    const refreshedResult = parseNativeIapSubscriptionPlan(refreshedNativePlan);
    const comparison = compareSubscriptionResults(
      nativeResult,
      refreshedResult,
      "revenue_cat_inquiry"
    );

    return {
      status: comparison.isMatch ? "match" : "mismatch",
      platform,
      value: normalizeSubscriptionResult(refreshedResult),
      diff: comparison.diff,
    };
  } catch (error) {
    return {
      status: "error",
      platform,
      error: serializeError(error),
    };
  }
}

async function buildNativePlanFromRevenueCatEvent(runtime, platform, event) {
  if (platform === "ios") {
    return buildIosNativePlanFromRevenueCatEvent(runtime, event);
  }

  return buildAndroidNativePlanFromRevenueCatEvent(runtime, event);
}

async function buildIosNativePlanFromRevenueCatEvent(runtime, event) {
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

async function buildAndroidNativePlanFromRevenueCatEvent(runtime, event) {
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
  let purchaseToken = String(
    event.purchase_token || event.purchaseToken || ""
  ).trim();

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

function normalizeSubscriptionResult(result) {
  return {
    isActive: result?.isActive === true,
    entitlementId: normalizeIapProductId(result?.entitlementId),
    expiresDate: normalizeDateString(result?.expiresDate),
    message: result?.message || "",
  };
}

function resolveStoreSubscriptionState(summary, expiresTime) {
  let statusLabel = "";
  if (typeof summary.statusLabel === "string") {
    statusLabel = summary.statusLabel.toUpperCase();
  }
  if (summary.status === 1) {
    statusLabel = "ACTIVE";
  }

  const isStatusActive = ["ACTIVE", "SUBSCRIPTION_STATE_ACTIVE"].includes(
    statusLabel
  );
  const isPastExpiresDate = expiresTime < Date.now();

  if (isPastExpiresDate) {
    return "expired";
  }

  if (isStatusActive) {
    return "active";
  }

  return "expired";
}

function isDateWithinTolerance(nativeDate, revenueCatDate) {
  if (!nativeDate || !revenueCatDate) {
    return nativeDate === revenueCatDate;
  }

  const nativeTime = new Date(nativeDate).getTime();
  const revenueCatTime = new Date(revenueCatDate).getTime();

  if (Number.isNaN(nativeTime) || Number.isNaN(revenueCatTime)) {
    return nativeDate === revenueCatDate;
  }

  return (
    Math.abs(nativeTime - revenueCatTime) <= EXPIRES_DATE_TOLERANCE_MS
  );
}

function getRevenueCatEvent(plan) {
  if (!plan || typeof plan !== "object") {
    return null;
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
    return null;
  }

  if (event?.type === "native-iap" || plan?.type === "native-iap") {
    return null;
  }

  const hasRevenueCatFields =
    !!event.store &&
    !!(
      event.original_transaction_id ||
      event.transaction_id ||
      event.purchase_token ||
      event.purchaseToken
    ) &&
    !!(
      event.product_id ||
      event.new_product_id ||
      event.entitlement_id ||
      event.entitlement_ids
    );

  if (!revenueCatType && !plan?.api_version && !plan?.event && !hasRevenueCatFields) {
    return null;
  }

  return event;
}

function getRevenueCatPlatform(event) {
  const store = String(event?.store || "").toUpperCase();
  const transactionId = String(
    event?.original_transaction_id || event?.transaction_id || ""
  ).trim();

  if (["APP_STORE", "MAC_APP_STORE"].includes(store)) {
    return "ios";
  }

  if (["PLAY_STORE", "GOOGLE_PLAY"].includes(store)) {
    return "android";
  }

  if (event?.purchase_token || event?.purchaseToken) {
    return "android";
  }

  if (transactionId.startsWith("GPA.")) {
    return "android";
  }

  if (/^\d+$/.test(transactionId)) {
    return "ios";
  }

  const platform = String(event?.platform || "").toLowerCase();
  return ["ios", "android"].includes(platform) ? platform : "unknown";
}

function buildSummaryLog(summary) {
  return {
    result: "summary",
    scanned: summary.scanned,
    checked: summary.checked,
    matched: summary.matched,
    mismatched: summary.mismatched,
  };
}

function normalizeIapProductId(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const productSegment = value.split(":").pop() || value;
  return productSegment.toLowerCase().replace(/_/g, "-");
}

function normalizeDateString(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function emptySubscriptionResult(message) {
  return {
    isActive: false,
    entitlementId: null,
    expiresDate: null,
    message,
  };
}

function parseJsonValue(value) {
  if (!value) {
    return null;
  }

  return typeof value === "string" ? JSON.parse(value) : value;
}

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

function resolveProjectPath(filePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(PROJECT_ROOT, filePath);
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : resolveProjectPath(filePath);
}

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }

  return value;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function serializeError(error) {
  return {
    status:
      error.response?.status || error.code || error.meta?.statusCode || null,
    data: error.response?.data || error.errors || error.meta?.body || null,
    message: error.message || "Unknown error",
  };
}

main().catch((error) => {
  logMemberResult({
    member: null,
    result: "error",
    error: serializeError(error),
  });
  process.exit(1);
});
