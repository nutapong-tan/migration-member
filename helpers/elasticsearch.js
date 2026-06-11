const { Client } = require("@elastic/elasticsearch");
const { requiredEnv } = require("./env");

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

  if (process.env.ELASTICSEARCH_USERNAME || process.env.ELASTICSEARCH_PASSWORD) {
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

  return new Client({
    requestTimeout: 300000,
    maxRetries: 3,
    node: requiredEnv("ELASTICSEARCH_HOST"),
  });
}

module.exports = {
  createElasticsearchClient,
};
