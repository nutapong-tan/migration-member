const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const PROJECT_ROOT = path.resolve(__dirname, "..");

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

function hasFlag(name) {
  return process.argv.includes(name) || getArgValue(name) === "true";
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

module.exports = {
  PROJECT_ROOT,
  getArgValue,
  hasFlag,
  loadEnvContext,
  normalizeScriptEnv,
  requiredEnv,
  resolvePath,
  resolveProjectPath,
};
