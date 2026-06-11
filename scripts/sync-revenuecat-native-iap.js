#!/usr/bin/env node

const {
  PROJECT_ROOT,
  loadEnvContext,
} = require("../helpers/env");
const { createElasticsearchClient } = require("../helpers/elasticsearch");
const {
  DEFAULT_ANDROID_PACKAGE_NAME,
  buildNativePlanFromRevenueCatEvent,
  createAndroidPublisherGetter,
  createAppleContextGetter,
} = require("../helpers/store-inquiry");
const {
  parseRevenueCatSubscriptionPlan,
  validateNativePlanWithRevenueCatInquiry,
} = require("../helpers/subscription-validation");
const {
  compactLogPayload,
  serializeError,
} = require("../helpers/logging");

const JOB_NAME = "SyncRevenueCatSubscriptionsToNativeIap";
const MEMBER_INDEX = "members";
const MEMBER_MIGRATION_INDEX = "members-migration";
const SYSTEM_CONFIG_INDEX = "system_configs";
const SCROLL_KEEP_ALIVE = "1d";
const SCROLL_PAGE_SIZE = 999;

process.chdir(PROJECT_ROOT);

let envContext = null;

async function main() {
  envContext = loadEnvContext();
  const runtime = createRuntime();
  let scrollId;

  logDivider("start");
  console.log(`[${JOB_NAME}] Starting`);
  logConfig(runtime);
  logDivider("members");

  // Step 1: Load tier mapping so RevenueCat/native product ids can map back to member tier.
  if (process.env.MERCHANT_ID) {
    try {
      const systemConfig = await runtime.esClient.get({
        index: SYSTEM_CONFIG_INDEX,
        id: process.env.MERCHANT_ID,
      });
      runtime.memberTiers = systemConfig?._source?.member_tiers || {};
    } catch (error) {
      logTierMappingWarning(
        "member_tiers fetch failed",
        serializeError(error)
      );
    }
  } else {
    logTierMappingWarning("MERCHANT_ID is missing");
  }

  try {
    // Step 2: Scroll every member that still has a subscription_plan value.
    const firstPage = await runtime.esClient.search({
      index: MEMBER_INDEX,
      scroll: SCROLL_KEEP_ALIVE,
      size: SCROLL_PAGE_SIZE,
      body: {
        query: {
          bool: {
            filter: [{ exists: { field: "subscription_plan" } }],
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
          // Step 3: Keep every RevenueCat subscription payload; skip native, miniapp, and non-renewing items.
          const parsed = parseRevenueCatSubscriptionPlan(member.subscription_plan);
          recordSourceType(runtime, parsed.source_type);
          if (!parsed.ok) {
            runtime.summary.skipped++;
            recordSkipReason(runtime, parsed.reason);
            logSkippedMember(memberLabel, parsed);
            continue;
          }

          // Step 4: Check latest subscription state directly from Apple or Google.
          const nativePlan = await buildNativePlanFromRevenueCatEvent(
            runtime,
            parsed.platform,
            parsed.event
          );

          const updateData = buildUpdateData(runtime, nativePlan);
          const validation = await validateNativePlanWithRevenueCatInquiry(
            runtime,
            nativePlan,
            parsed.event,
            parsed.platform
          );
          const updateLog = buildUpdateMemberLog(
            memberLabel,
            updateData,
            nativePlan,
            parsed,
            validation
          );

          runtime.summary.mapped++;
          runtime.summary.by_platform[parsed.platform]++;
          logUpdateMember(updateLog);

          // Stage 2 draft: after log validation, uncomment this block to copy
          // the full member document into members-migration without touching members.
          // The old values stay in ref_* fields for rollback tracing.
          // const migrationDocument = buildMigrationDocument(
          //   member,
          //   updateData,
          //   new Date().toISOString(),
          //   runtime.migrationTag
          // );
          // await runtime.esClient.index({
          //   index: MEMBER_MIGRATION_INDEX,
          //   id: member._id,
          //   document: migrationDocument,
          // });

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
          logMemberError(memberLabel, error);
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
        logGeneralError("Failed to clear scroll", error);
      });
    }
  }

  logDivider("summary");
  logCompleted(runtime.summary);
  logDivider("end");
}

function createRuntime() {
  const summary = {
    scanned: 0,
    skipped: 0,
    mapped: 0,
    errors: 0,
    by_platform: {
      ios: 0,
      android: 0,
    },
    by_type: {},
    skip_reasons: {},
  };
  return {
    esClient: createElasticsearchClient(),
    summary,
    migrationTag: buildDateTimeTag(new Date()),
    memberTiers: {},
    appleEnv: process.env.APPLE_ENV || "PRODUCTION",
    androidPackageName:
      process.env.ANDROID_PACKAGE_NAME || DEFAULT_ANDROID_PACKAGE_NAME,
    getAppleContext: createAppleContextGetter(),
    getAndroidPublisher: createAndroidPublisherGetter(),
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

function buildUpdateMemberLog(
  memberLabel,
  updateData,
  nativePlan,
  parsed,
  validation
) {
  const { subscription_plan: _subscriptionPlan, ...logUpdateData } = updateData;
  const logPayload = {
    member: memberLabel,
    source_type: parsed.source_type,
    ...logUpdateData,
    result: validation.result,
    is_active: validation.is_active,
    platform: nativePlan?.platform || null,
    reason: validation.reason,
    error: validation.error,
  };

  if (validation.diff && Object.keys(validation.diff).length > 0) {
    logPayload.diff = validation.diff;
  }

  return logPayload;
}

function logConfig(runtime) {
  logJson("config", {
    memberIndex: MEMBER_INDEX,
    migrationIndex: MEMBER_MIGRATION_INDEX,
    scrollPageSize: SCROLL_PAGE_SIZE,
    scriptEnv: envContext.name,
    migrationTag: runtime.migrationTag,
    writeMode: "members-migration",
    envFile: envContext.file,
    appleEnv: runtime.appleEnv,
    androidPackageName: runtime.androidPackageName,
  });
}

function logSkippedMember(memberLabel, parsed) {
  logJson("skipMember", {
    member: memberLabel,
    type: parsed.source_type,
    skipped: true,
    reason: parsed.reason,
  });
}

function logUpdateMember(payload) {
  logJson("updateMember", {
    member: payload.member,
    type: payload.source_type === "revenuecat" ? undefined : payload.source_type,
    result: payload.result,
    is_active: payload.is_active,
    platform: payload.platform,
    reason: payload.reason,
    error: buildLogError(payload.error),
    diff: payload.diff,
  });
}

function logMemberError(memberLabel, error) {
  const serialized = serializeError(error);
  logJson("member", {
    member: memberLabel,
    skipped: true,
    result: "error",
    error: buildLogError(serialized),
  });
}

function logGeneralError(message, error) {
  const serialized = serializeError(error);
  logJson("error", {
    message,
    error: serialized,
  });
}

function logTierMappingWarning(message, error) {
  logJson("warning", {
    message,
    status: error?.status,
    reason: getErrorReason(error),
    action: "continue_without_tier_mapping",
  });
}

function getErrorReason(error) {
  return error?.data?.error?.reason || error?.message;
}

function buildLogError(error) {
  if (!error || typeof error !== "object") {
    return error;
  }

  const { message: _message, ...logError } = error;
  return logError;
}

function logCompleted(summary) {
  logJsonPretty("summary", {
    result: "summary",
    scanned: summary.scanned,
    skipped: summary.skipped,
    mapped: summary.mapped,
    errors: summary.errors,
  });
}

function logDivider(label) {
  console.log(`------------- ${label} -------------`);
}

function recordSourceType(runtime, sourceType) {
  const type = sourceType || "unknown";
  runtime.summary.by_type[type] = (runtime.summary.by_type[type] || 0) + 1;
}

function recordSkipReason(runtime, reason) {
  const key = reason || "unknown";
  runtime.summary.skip_reasons[key] =
    (runtime.summary.skip_reasons[key] || 0) + 1;
}

function sortCountObject(counts) {
  return Object.fromEntries(sortCounts(counts));
}

function sortCounts(counts) {
  return Object.entries(counts || {}).sort((left, right) => {
    const countDiff = right[1] - left[1];
    return countDiff !== 0 ? countDiff : left[0].localeCompare(right[0]);
  });
}

function logJson(eventName, payload) {
  console.log(`${JOB_NAME}.${eventName}`, JSON.stringify(compactLogPayload(payload)));
}

function logJsonPretty(eventName, payload) {
  console.log(
    `${JOB_NAME}.${eventName}`,
    JSON.stringify(compactLogPayload(payload), null, 2)
  );
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

main().catch((error) => {
  console.error(
    `[${JOB_NAME}] Failed`,
    JSON.stringify(serializeError(error), null, 2)
  );
  process.exit(1);
});
