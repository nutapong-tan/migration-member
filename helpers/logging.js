function formatTimestamp(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function serializeError(error) {
  return {
    status:
      error.response?.status || error.code || error.meta?.statusCode || null,
    data: error.response?.data || error.errors || error.meta?.body || null,
    message: error.message || "Unknown error",
  };
}

function compactLogPayload(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => compactLogPayload(item))
      .filter((item) => item !== undefined);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const compacted = compactLogPayload(item);
    if (shouldKeepLogValue(compacted)) {
      result[key] = compacted;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function shouldKeepLogValue(value) {
  if (value === undefined || value === null || value === "") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return true;
}

module.exports = {
  compactLogPayload,
  formatTimestamp,
  serializeError,
};
