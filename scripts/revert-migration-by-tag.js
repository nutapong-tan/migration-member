#!/usr/bin/env node

const {
  PROJECT_ROOT,
  getArgValue,
  loadEnvContext,
} = require("../helpers/env");
const { createElasticsearchClient } = require("../helpers/elasticsearch");
const { serializeError } = require("../helpers/logging");

const JOB_NAME = "RevertMembersFromMigrationTag";
const MEMBER_INDEX = "members";
const MEMBER_MIGRATION_INDEX = "members-migration";
const SCROLL_KEEP_ALIVE = "2m";
const SCROLL_PAGE_SIZE = 500;

process.chdir(PROJECT_ROOT);

async function main() {
  const envContext = loadEnvContext();
  const runtime = createRuntime();

  if (!runtime.tag) {
    throw new Error("Missing required --tag=YYYYMMDD-HHmmss");
  }

  let scrollId;

  console.log(`[${JOB_NAME}] Starting`);
  console.log(
    `[${JOB_NAME}] Config ${JSON.stringify({
      memberIndex: MEMBER_INDEX,
      migrationIndex: MEMBER_MIGRATION_INDEX,
      scrollPageSize: SCROLL_PAGE_SIZE,
      scriptEnv: envContext.name,
      envFile: envContext.file,
      tag: runtime.tag,
    })}`
  );

  try {
    const firstPage = await searchMigrationMembers(runtime);

    scrollId = firstPage._scroll_id;
    let hits = getPageHits(firstPage);

    while (hits.length > 0) {
      await processBatch(runtime, hits);

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

  logSummary(runtime);
}

function createRuntime() {
  return {
    esClient: createElasticsearchClient(),
    tag: getArgValue("--tag"),
    summary: {
      scanned: 0,
      restored: 0,
      deleted_migration_docs: 0,
      skipped: 0,
      errors: 0,
      delete_errors: 0,
      skip_reasons: {},
      samples: [],
    },
  };
}

function searchMigrationMembers(runtime) {
  return runtime.esClient.search({
    index: MEMBER_MIGRATION_INDEX,
    scroll: SCROLL_KEEP_ALIVE,
    size: SCROLL_PAGE_SIZE,
    _source: [
      "member_id",
      "tag",
      "tier",
      "subscription_plan",
      "ref_tier",
      "ref_subscription_plan",
    ],
    body: {
      query: {
        bool: {
          should: [
            { term: { "tag.keyword": runtime.tag } },
            { term: { tag: runtime.tag } },
          ],
          minimum_should_match: 1,
        },
      },
    },
  });
}

function getPageHits(page) {
  return page.hits?.hits || [];
}

async function processBatch(runtime, hits) {
  for (const hit of hits) {
    await processMigrationMember(runtime, hit);
  }
}

async function processMigrationMember(runtime, hit) {
  const source = hit._source || {};
  const summary = runtime.summary;
  const memberLabel = source.member_id || hit._id;

  summary.scanned++;

  const restoreData = buildRestoreData(source);
  if (!restoreData.ok) {
    recordSkip(summary, restoreData.reason, memberLabel, hit._id);
    return;
  }

  addSample(summary, {
    id: hit._id,
    member: memberLabel,
    tier: restoreData.doc.tier,
    has_subscription_plan: restoreData.doc.subscription_plan !== null,
    will_delete_migration_doc: true,
  });

  try {
    await runtime.esClient.update({
      index: MEMBER_INDEX,
      id: hit._id,
      doc: {
        ...restoreData.doc,
        updated_at: new Date().toISOString(),
      },
    });
    summary.restored++;
    await deleteMigrationDocument(runtime, hit._id, memberLabel);
  } catch (error) {
    summary.errors++;
    console.log(
      `[${JOB_NAME}] member=${memberLabel} id=${hit._id} status=error ${JSON.stringify(
        serializeError(error)
      )}`
    );
  }
}

async function deleteMigrationDocument(runtime, id, memberLabel) {
  try {
    await runtime.esClient.delete({
      index: MEMBER_MIGRATION_INDEX,
      id,
    });
    runtime.summary.deleted_migration_docs++;
  } catch (error) {
    runtime.summary.delete_errors++;
    console.log(
      `[${JOB_NAME}] member=${memberLabel} id=${id} status=delete-migration-error ${JSON.stringify(
        serializeError(error)
      )}`
    );
  }
}

function buildRestoreData(source) {
  if (!Object.prototype.hasOwnProperty.call(source, "ref_tier")) {
    return {
      ok: false,
      reason: "missing ref_tier",
    };
  }

  if (!Object.prototype.hasOwnProperty.call(source, "ref_subscription_plan")) {
    return {
      ok: false,
      reason: "missing ref_subscription_plan",
    };
  }

  return {
    ok: true,
    doc: {
      tier: source.ref_tier ?? null,
      subscription_plan: source.ref_subscription_plan ?? null,
    },
  };
}

function recordSkip(summary, reason, memberLabel, id) {
  summary.skipped++;
  incrementCount(summary.skip_reasons, reason);
  addSample(summary, {
    id,
    member: memberLabel,
    skipped: reason,
  });
}

function addSample(summary, sample) {
  summary.samples.push(sample);
}

function incrementCount(target, key) {
  const normalizedKey = String(key || "unknown");
  target[normalizedKey] = (target[normalizedKey] || 0) + 1;
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

function logSummary(runtime) {
  const { summary } = runtime;

  console.log(`${JOB_NAME}.summary`);
  console.log("");
  console.log(`tag: ${runtime.tag}`);
  console.log(`scanned migration docs: ${summary.scanned}`);
  console.log(`restored to members: ${summary.restored}`);
  console.log(`deleted migration docs: ${summary.deleted_migration_docs}`);
  console.log(`skipped: ${summary.skipped}`);
  console.log(`errors: ${summary.errors}`);
  console.log(`delete errors: ${summary.delete_errors}`);

  if (Object.keys(summary.skip_reasons).length > 0) {
    console.log("");
    console.log("skip reasons");
    for (const [reason, count] of sortCounts(summary.skip_reasons)) {
      console.log(`- ${reason}: ${count}`);
    }
  }
}

function sortCounts(counts) {
  return Object.entries(counts).sort((left, right) => {
    const countDiff = right[1] - left[1];
    return countDiff !== 0 ? countDiff : left[0].localeCompare(right[0]);
  });
}

main().catch((error) => {
  console.error(`[${JOB_NAME}] Fatal`, serializeError(error));
  process.exit(1);
});
