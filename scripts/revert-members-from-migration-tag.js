#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { Client } = require("@elastic/elasticsearch");

const JOB_NAME = "RevertMembersFromMigrationTag";
const PROJECT_ROOT = path.resolve(__dirname, "..");
const MEMBER_INDEX = "members";
const MEMBER_MIGRATION_INDEX = "members-migration";
const SCROLL_KEEP_ALIVE = "2m";
const BATCH_SIZE = 500;

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
      batchSize: BATCH_SIZE,
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

function createElasticsearchClient() {
  if (process.env.ELASTICSEARCH_CLOUD_ID && process.env.ELASTICSEARCH_API_KEY) {
    return new Client({
      requestTimeout: 300000,
      maxRetries: 3,
      cloud: { id: requiredEnv("ELASTICSEARCH_CLOUD_ID") },
      auth: { apiKey: requiredEnv("ELASTICSEARCH_API_KEY") },
    });
  }

  if (process.env.ELASTICSEARCH_API_KEY) {
    return new Client({
      requestTimeout: 300000,
      maxRetries: 3,
      node: requiredEnv("ELASTICSEARCH_HOST"),
      auth: { apiKey: requiredEnv("ELASTICSEARCH_API_KEY") },
    });
  }

  return new Client({
    requestTimeout: 300000,
    maxRetries: 3,
    node: requiredEnv("ELASTICSEARCH_HOST"),
    auth: {
      username: requiredEnv("ELASTICSEARCH_USERNAME"),
      password: requiredEnv("ELASTICSEARCH_PASSWORD"),
    },
  });
}

function searchMigrationMembers(runtime) {
  return runtime.esClient.search({
    index: MEMBER_MIGRATION_INDEX,
    scroll: SCROLL_KEEP_ALIVE,
    size: BATCH_SIZE,
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
  if (summary.samples.length < 10) {
    summary.samples.push(sample);
  }
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
  console.error(`[${JOB_NAME}] Fatal`, serializeError(error));
  process.exit(1);
});
