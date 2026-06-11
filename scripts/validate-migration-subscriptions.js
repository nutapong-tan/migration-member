#!/usr/bin/env node

const {
  PROJECT_ROOT,
  loadEnvContext,
} = require("../helpers/env");
const { createElasticsearchClient } = require("../helpers/elasticsearch");
const {
  DEFAULT_ANDROID_PACKAGE_NAME,
  createAndroidPublisherGetter,
  createAppleContextGetter,
} = require("../helpers/store-inquiry");
const {
  compareSubscriptionResults,
  getNativeIapSubscriptionFromMemberInfo,
  getRevenueCatSubscriptionFromMemberInfo,
  validateNativeResultWithRevenueCatInquiry,
} = require("../helpers/subscription-validation");
const { serializeError } = require("../helpers/logging");

const JOB_NAME = "ValidateMembersMigrationSubscription";
const MEMBER_MIGRATION_INDEX = "members-migration";
const SCROLL_KEEP_ALIVE = "2m";
const SCROLL_PAGE_SIZE = 100;

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
    size: SCROLL_PAGE_SIZE,
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
  const validation = await validateNativeResultWithRevenueCatInquiry(
    runtime,
    subscriptionPair.native.value,
    subscriptionPair.revenueCat
  );

  if (["match", "match-after-inquiry"].includes(validation.result)) {
    recordMemberMatch(
      runtime,
      memberLabel,
      validation.result,
      subscriptionPair.native.value
    );
    return;
  }

  runtime.summary.mismatched++;

  if (validation.result === "mismatch-after-revenue-inquiry") {
    logMemberResult({
      member: memberLabel,
      result: validation.result,
      diff: validation.diff,
    });
    return;
  }

  logMemberResult({
    member: memberLabel,
    result: validation.result,
    reason: validation.reason,
    error: validation.error,
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

function createSummary() {
  return {
    scanned: 0,
    checked: 0,
    matched: 0,
    mismatched: 0,
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

function buildSummaryLog(summary) {
  return {
    result: "summary",
    scanned: summary.scanned,
    checked: summary.checked,
    matched: summary.matched,
    mismatched: summary.mismatched,
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
