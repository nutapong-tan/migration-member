#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { Client } = require("@elastic/elasticsearch");

const JOB_NAME = "ValidateMembersMigrationSubscription";
const PROJECT_ROOT = path.resolve(__dirname, "..");
const MEMBER_MIGRATION_INDEX = "members-migration";
const SCROLL_KEEP_ALIVE = "2m";
const BATCH_SIZE = 100;
const EXPIRES_DATE_TOLERANCE_MS = 2_000;

process.chdir(PROJECT_ROOT);

async function main() {
  loadEnvContext();
  const runtime = createRuntime();
  let scrollId;

  try {
    const firstPage = await runtime.esClient.search({
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

    scrollId = firstPage._scroll_id;
    let hits = firstPage.hits?.hits || [];

    while (hits.length > 0) {
      for (const hit of hits) {
        runtime.summary.scanned++;

        const member = {
          _id: hit._id,
          ...(hit._source || {}),
        };
        const memberLabel = member.member_id || member._id;

        try {
          const nativeResult = getNativeIapSubscriptionFromMemberInfo(
            member.subscription_plan
          );
          const revenueCatResult = getRevenueCatSubscriptionFromMemberInfo(
            member.ref_subscription_plan
          );

          const nativePlan = parseJsonValue(member.subscription_plan);
          const nativePlatform = getNativePlatform(nativePlan);
          runtime.summary.by_platform[nativePlatform] =
            (runtime.summary.by_platform[nativePlatform] || 0) + 1;

          if (!nativeResult.isNativeIap) {
            skip(runtime, "subscription_plan is not native-iap");
            logMemberResult({
              member: memberLabel,
              result: "skipped",
              reason: "subscription_plan is not native-iap",
            });
            continue;
          }

          if (!revenueCatResult.isRevenueCat) {
            skip(runtime, "ref_subscription_plan is not RevenueCat");
            logMemberResult({
              member: memberLabel,
              result: "skipped",
              reason: "ref_subscription_plan is not RevenueCat",
            });
            continue;
          }

          runtime.summary.checked++;
          const comparison = compareSubscriptionResults(
            nativeResult.value,
            revenueCatResult.value
          );

          updateActiveStateSummary(
            runtime.summary,
            nativeResult.value,
            revenueCatResult.value
          );

          logMemberResult({
            member: memberLabel,
            result: comparison.isMatch ? "match" : "mismatch",
            diff: comparison.diff,
          });

          if (comparison.isMatch) {
            runtime.summary.matched++;
            continue;
          }

          runtime.summary.mismatched++;
          for (const field of Object.keys(comparison.diff)) {
            runtime.summary.mismatch_fields[field] =
              (runtime.summary.mismatch_fields[field] || 0) + 1;
          }
        } catch (error) {
          runtime.summary.errors++;
          logMemberResult({
            member: memberLabel,
            result: "error",
            error: serializeError(error),
          });
        }
      }

      if (!scrollId) {
        break;
      }

      const nextPage = await runtime.esClient.scroll({
        scroll_id: scrollId,
        scroll: SCROLL_KEEP_ALIVE,
      });
      scrollId = nextPage._scroll_id;
      hits = nextPage.hits?.hits || [];
    }
  } finally {
    if (scrollId) {
      await runtime.esClient.clearScroll({ scroll_id: scrollId }).catch((error) => {
        logMemberResult({
          member: null,
          result: "error",
          error: serializeError(error),
        });
      });
    }
  }
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

  return {
    esClient,
    summary: {
      scanned: 0,
      checked: 0,
      matched: 0,
      mismatched: 0,
      skipped: 0,
      errors: 0,
      by_platform: {},
      by_active_state: {
        both_active: 0,
        both_inactive: 0,
        native_only_active: 0,
        revenue_cat_only_active: 0,
      },
      skipped_reasons: {},
      mismatch_fields: {},
    },
  };
}

function logMemberResult(payload) {
  const logPayload = { ...payload };

  if (logPayload.diff && Object.keys(logPayload.diff).length === 0) {
    delete logPayload.diff;
  }

  console.log(`${JOB_NAME}.result`, JSON.stringify(logPayload));
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

function compareSubscriptionResults(nativeResult, revenueCatResult) {
  const normalizedNative = normalizeSubscriptionResult(nativeResult);
  const normalizedRevenueCat = normalizeSubscriptionResult(revenueCatResult);
  const diff = {};

  for (const field of ["isActive", "entitlementId"]) {
    if (normalizedNative[field] !== normalizedRevenueCat[field]) {
      diff[field] = {
        native_iap: normalizedNative[field],
        revenue_cat: normalizedRevenueCat[field],
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
      revenue_cat: normalizedRevenueCat.expiresDate,
    };
  }

  return {
    isMatch: Object.keys(diff).length === 0,
    diff,
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

function getNativePlatform(plan) {
  const platform = String(plan?.platform || "unknown").toLowerCase();

  return ["ios", "android"].includes(platform) ? platform : "unknown";
}

function updateActiveStateSummary(summary, nativeResult, revenueCatResult) {
  if (nativeResult.isActive && revenueCatResult.isActive) {
    summary.by_active_state.both_active++;
    return;
  }

  if (!nativeResult.isActive && !revenueCatResult.isActive) {
    summary.by_active_state.both_inactive++;
    return;
  }

  if (nativeResult.isActive) {
    summary.by_active_state.native_only_active++;
    return;
  }

  summary.by_active_state.revenue_cat_only_active++;
}

function skip(runtime, reason) {
  runtime.summary.skipped++;
  runtime.summary.skipped_reasons[reason] =
    (runtime.summary.skipped_reasons[reason] || 0) + 1;
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

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }

  return value;
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
