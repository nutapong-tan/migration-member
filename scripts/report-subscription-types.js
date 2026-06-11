#!/usr/bin/env node

const {
  PROJECT_ROOT,
  getArgValue,
  hasFlag,
  loadEnvContext,
} = require("../helpers/env");
const { createElasticsearchClient } = require("../helpers/elasticsearch");
const { serializeError } = require("../helpers/logging");

const JOB_NAME = "ReportMemberSubscriptionPlanTypes";
const MEMBER_INDEX = "members";
const SCROLL_KEEP_ALIVE = "1d";
const SCROLL_PAGE_SIZE = 1000;

process.chdir(PROJECT_ROOT);

async function main() {
  const envContext = loadEnvContext();
  const runtime = createRuntime();
  let scrollId;

  if (runtime.filters.verbose) {
    console.log(`[${JOB_NAME}] Starting`);
    console.log(
      `[${JOB_NAME}] Config ${JSON.stringify({
        memberIndex: MEMBER_INDEX,
        scrollPageSize: SCROLL_PAGE_SIZE,
        scriptEnv: envContext.name,
        envFile: envContext.file,
        filters: runtime.filters,
      })}`
    );
  }

  try {
    const firstPage = await searchMembers(runtime);

    scrollId = firstPage._scroll_id;
    let hits = getPageHits(firstPage);

    while (hits.length > 0) {
      processBatch(runtime, hits);

      if (!scrollId) {
        break;
      }

      const nextPage = await runtime.esClient.scroll({
        scroll_id: scrollId,
        scroll: SCROLL_KEEP_ALIVE,
      });

      scrollId = nextPage._scroll_id;
      hits = getPageHits(nextPage);
    }
  } finally {
    await clearScroll(runtime, scrollId);
  }

  logSummary(runtime.summary, runtime.filters);
}

function createRuntime() {
  return {
    esClient: createElasticsearchClient(),
    filters: createFilters(),
    summary: createSummary(),
  };
}

function createFilters() {
  const detailsValue = getArgValue("--details");

  return {
    activeOnly: hasFlag("--active-only"),
    untransferredOnly: hasFlag("--untransferred-only"),
    includeMissing: hasFlag("--include-missing"),
    details: hasFlag("--details") || !!detailsValue,
    detailsBucket: detailsValue && detailsValue !== "true" ? detailsValue : null,
    jsonOutput: hasFlag("--json"),
    verbose: hasFlag("--verbose"),
  };
}

function createSummary() {
  return {
    scanned: 0,
    with_subscription_plan: 0,
    missing_subscription_plan: 0,
    empty_subscription_plan: 0,
    invalid_json: 0,
    by_type: {
      revenuecat: createTypeSummary(),
      "native-iap": createTypeSummary(),
      miniapp: createTypeSummary(),
      unknown: createTypeSummary(),
    },
    exact_type: {},
    parse_errors: {},
    samples: {
      revenuecat: [],
      "native-iap": [],
      miniapp: [],
      unknown: [],
      invalid_json: [],
    },
    details: [],
  };
}

function createTypeSummary() {
  return {
    total: 0,
    ios: 0,
    android: 0,
    unknown_platform: 0,
  };
}

function searchMembers(runtime) {
  return runtime.esClient.search({
    index: MEMBER_INDEX,
    scroll: SCROLL_KEEP_ALIVE,
    size: SCROLL_PAGE_SIZE,
    _source: ["member_id", "subscription_plan", "active", "is_transferred"],
    body: {
      query: buildQuery(runtime.filters),
    },
  });
}

function buildQuery(filters) {
  const filter = [];

  if (!filters.includeMissing) {
    filter.push({ exists: { field: "subscription_plan" } });
  }

  if (filters.activeOnly) {
    filter.push({ term: { active: true } });
  }

  if (filters.untransferredOnly) {
    filter.push({ term: { is_transferred: false } });
  }

  if (filter.length === 0) {
    return { match_all: {} };
  }

  return { bool: { filter } };
}

function getPageHits(page) {
  return page.hits?.hits || [];
}

function processBatch(runtime, hits) {
  for (const hit of hits) {
    processMember(runtime, hit);
  }
}

function processMember(runtime, hit) {
  const { filters, summary } = runtime;
  const source = hit._source || {};
  const memberLabel = source.member_id || hit._id;

  summary.scanned++;

  if (!Object.prototype.hasOwnProperty.call(source, "subscription_plan")) {
    summary.missing_subscription_plan++;
    return;
  }

  if (isEmptyValue(source.subscription_plan)) {
    summary.empty_subscription_plan++;
    return;
  }

  summary.with_subscription_plan++;

  const classification = classifySubscriptionPlan(source.subscription_plan);

  if (classification.bucket === "invalid_json") {
    summary.invalid_json++;
    incrementCount(summary.parse_errors, classification.reason);
    addSample(summary.samples.invalid_json, {
      member: memberLabel,
      reason: classification.reason,
    });
    return;
  }

  recordClassification(summary, filters, hit, classification, memberLabel);
}

function recordClassification(summary, filters, hit, classification, memberLabel) {
  const source = hit._source || {};
  const bucket = summary.by_type[classification.bucket] || summary.by_type.unknown;
  const platformKey = ["ios", "android"].includes(classification.platform)
    ? classification.platform
    : "unknown_platform";

  bucket.total++;
  bucket[platformKey]++;

  incrementCount(summary.exact_type, classification.exactType || "missing");
  addSample(summary.samples[classification.bucket], {
    member: memberLabel,
    exact_type: classification.exactType || null,
    platform: classification.platform || null,
  });

  if (
    filters.details &&
    (!filters.detailsBucket || filters.detailsBucket === classification.bucket)
  ) {
    const migrationStatus = getMigrationStatus(source, classification);

    summary.details.push({
      id: hit._id,
      member: memberLabel,
      bucket: classification.bucket,
      exact_type: classification.exactType || null,
      platform: classification.platform || null,
      active: source.active ?? null,
      is_transferred: source.is_transferred ?? null,
      migration_target: migrationStatus.target,
      migration_reason: migrationStatus.reason,
      event: classification.event,
    });
  }
}

function getMigrationStatus(source, classification) {
  if (classification.bucket !== "revenuecat") {
    return {
      target: false,
      reason: "not revenuecat",
    };
  }

  if (
    String(classification.event?.type || "").toUpperCase() ===
    "NON_RENEWING_PURCHASE"
  ) {
    return {
      target: false,
      reason: "RevenueCat event is non-renewing purchase",
    };
  }

  return {
    target: true,
    reason: "migration target",
  };
}

function classifySubscriptionPlan(subscriptionPlan) {
  let plan;

  try {
    plan =
      typeof subscriptionPlan === "string"
        ? JSON.parse(subscriptionPlan)
        : subscriptionPlan;
  } catch (error) {
    return {
      bucket: "invalid_json",
      reason: error.message || "invalid JSON",
    };
  }

  if (!plan || typeof plan !== "object") {
    return {
      bucket: "unknown",
      exactType: typeof plan,
      platform: null,
    };
  }

  const revenueCatType = isRevenueCatType(plan);
  const event =
    plan?.event ||
    plan?.data?.event ||
    (revenueCatType && plan?.data ? plan.data : null) ||
    plan;
  const exactType = getExactType(plan, event);
  const platform = extractPlatform(plan, event);

  const eventSummary = getEventSummary(event);

  if (isNativeIap(plan, event)) {
    return { bucket: "native-iap", exactType, platform, event: eventSummary };
  }

  if (isMiniapp(plan, event)) {
    return { bucket: "miniapp", exactType, platform, event: eventSummary };
  }

  if (revenueCatType || isRevenueCatEvent(plan, event)) {
    return { bucket: "revenuecat", exactType, platform, event: eventSummary };
  }

  return { bucket: "unknown", exactType, platform, event: eventSummary };
}

function getEventSummary(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const transactionId = String(
    event.original_transaction_id || event.transaction_id || ""
  ).trim();

  return {
    type: event.type || null,
    store: event.store || null,
    product_id: event.new_product_id || event.product_id || null,
    entitlement_id:
      event.entitlement_id ||
      (Array.isArray(event.entitlement_ids) ? event.entitlement_ids[0] : null) ||
      null,
    transaction_id_suffix: transactionId ? transactionId.slice(-6) : null,
  };
}

function getExactType(plan, event) {
  const value = plan?.type || event?.type || plan?.source || plan?.provider;
  const text = String(value || "").trim();

  return text || null;
}

function isNativeIap(plan, event) {
  const candidates = [
    plan?.type,
    event?.type,
    plan?.source,
    plan?.provider,
  ].map(normalizeType);

  return candidates.some((value) =>
    [
      "native-iap",
      "native-inapp-purchase",
      "native-in-app-purchase",
      "native-inapp-perchese",
    ].includes(value)
  );
}

function isMiniapp(plan, event) {
  const candidates = [
    plan?.type,
    event?.type,
    plan?.source,
    plan?.provider,
  ].map(normalizeType);

  return (
    candidates.some((value) => value.includes("miniapp") || value.includes("mini-app")) ||
    !!event?.content ||
    !!event?.tier_id ||
    !!event?.data?.subscription ||
    !!plan?.data?.subscription
  );
}

function isRevenueCatType(plan) {
  return [plan?.type, plan?.source, plan?.provider]
    .map(normalizeType)
    .some((value) => value.includes("revenue"));
}

function isRevenueCatEvent(plan, event) {
  const transactionId = String(
    event?.original_transaction_id || event?.transaction_id || ""
  ).trim();

  return (
    !!plan?.api_version ||
    !!plan?.event ||
    !!(
      event?.store &&
      transactionId &&
      (event?.product_id ||
        event?.new_product_id ||
        event?.entitlement_id ||
        (Array.isArray(event?.entitlement_ids) && event.entitlement_ids.length > 0))
    )
  );
}

function extractPlatform(plan, event) {
  const platform = normalizePlatform(plan?.platform || event?.platform);

  if (platform) {
    return platform;
  }

  const store = String(event?.store || "").toUpperCase();
  if (["APP_STORE", "MAC_APP_STORE"].includes(store)) {
    return "ios";
  }
  if (["PLAY_STORE", "GOOGLE_PLAY"].includes(store)) {
    return "android";
  }

  const transactionId = String(
    event?.original_transaction_id || event?.transaction_id || ""
  ).trim();
  if (transactionId.startsWith("GPA.")) {
    return "android";
  }
  if (/^\d+$/.test(transactionId)) {
    return "ios";
  }

  return null;
}

function normalizePlatform(value) {
  const platform = String(value || "")
    .trim()
    .toLowerCase();

  if (["ios", "apple", "app_store", "app-store"].includes(platform)) {
    return "ios";
  }
  if (["android", "google", "play_store", "google_play"].includes(platform)) {
    return "android";
  }

  return null;
}

function normalizeType(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

function isEmptyValue(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function incrementCount(target, key) {
  const normalizedKey = String(key || "unknown");
  target[normalizedKey] = (target[normalizedKey] || 0) + 1;
}

function addSample(samples, sample) {
  samples.push(sample);
}

async function clearScroll(runtime, scrollId) {
  if (!scrollId) {
    return;
  }

  await runtime.esClient.clearScroll({ scroll_id: scrollId }).catch((error) => {
    console.log(
      `[${JOB_NAME}] clearScrollError ${JSON.stringify(serializeError(error))}`
    );
  });
}

function logSummary(summary, filters) {
  if (filters.jsonOutput) {
    console.log(`${JOB_NAME}.summary`, JSON.stringify(summary));
    return;
  }

  for (const type of ["native-iap", "revenuecat", "miniapp", "unknown"]) {
    const result = summary.by_type[type];
    console.log(
      `- ${type}: ${result.total} (iOS ${result.ios}, Android ${result.android}, unknown ${result.unknown_platform})`
    );
  }

  if (summary.details.length > 0) {
    console.log("");
    console.log("details");
    for (const detail of summary.details) {
      const event = detail.event || {};
      console.log(
        [
          `- member=${detail.member}`,
          `id=${detail.id}`,
          `type=${detail.exact_type || "missing"}`,
          `platform=${detail.platform || "unknown"}`,
          `active=${detail.active}`,
          `is_transferred=${detail.is_transferred}`,
          `migration_target=${detail.migration_target ? "yes" : "no"}`,
          `migration_reason=${formatDetailValue(detail.migration_reason)}`,
          `event_type=${event.type || "missing"}`,
          `store=${event.store || "missing"}`,
          `product=${event.product_id || "missing"}`,
          `transaction_suffix=${event.transaction_id_suffix || "missing"}`,
        ].join(" ")
      );
    }
  }
}

function sortCounts(counts) {
  return Object.entries(counts).sort((left, right) => {
    const countDiff = right[1] - left[1];
    return countDiff !== 0 ? countDiff : left[0].localeCompare(right[0]);
  });
}

function formatDetailValue(value) {
  return String(value || "missing").replace(/\s+/g, "_");
}

main().catch((error) => {
  console.error(`[${JOB_NAME}] Fatal`, serializeError(error));
  process.exit(1);
});
