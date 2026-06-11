const {
  buildNativePlanFromRevenueCatEvent,
} = require("./store-inquiry");

const EXPIRES_DATE_TOLERANCE_MS = 2_000;

function parseRevenueCatSubscriptionPlan(subscriptionPlan) {
  let plan;

  try {
    plan =
      typeof subscriptionPlan === "string"
        ? JSON.parse(subscriptionPlan)
        : subscriptionPlan;
  } catch (error) {
    return {
      ok: false,
      source_type: "invalid-json",
      reason: `invalid JSON: ${error.message}`,
    };
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
    return {
      ok: false,
      source_type: "unknown",
      reason: "subscription_plan is not an object",
    };
  }

  if (plan?.type === "native-iap" || event?.type === "native-iap") {
    return buildRevenueCatParseResult({
      ok: false,
      sourceType: "native-iap",
      reason: "already native-iap",
      event,
    });
  }

  if (event.content || event.tier_id || event.data?.subscription) {
    return buildRevenueCatParseResult({
      ok: false,
      sourceType: "miniapp",
      reason: "miniapp subscription shape",
      event,
    });
  }

  const eventType = String(event.type || "").toUpperCase();
  const productId = String(event.new_product_id || event.product_id || "");
  const transactionId = String(
    event.original_transaction_id || event.transaction_id || ""
  );
  const hasRevenueCatSource =
    revenueCatType ||
    String(plan?.source || plan?.provider || "")
      .toLowerCase()
      .includes("revenue") ||
    !!plan?.api_version ||
    !!plan?.event;
  const hasRevenueCatFields =
    !!event.store &&
    !!transactionId &&
    !!(
      event.product_id ||
      event.new_product_id ||
      event.entitlement_id ||
      event.entitlement_ids
    );
  const hasEntitlement =
    !!event.entitlement_id ||
    (Array.isArray(event.entitlement_ids) && event.entitlement_ids.length > 0);
  const looksLikeSubscription =
    eventType !== "NON_RENEWING_PURCHASE" &&
    !!(
      event.expiration_at_ms ||
      event.original_transaction_id ||
      hasEntitlement ||
      /^(vip|vvip)([_-]|$)/i.test(productId.split(":").pop() || "")
    );

  if (eventType === "NON_RENEWING_PURCHASE") {
    return buildRevenueCatParseResult({
      ok: false,
      sourceType: "revenuecat",
      reason: "RevenueCat event is non-renewing purchase",
      event,
    });
  }

  if (!hasRevenueCatSource && !hasRevenueCatFields) {
    return buildRevenueCatParseResult({
      ok: false,
      sourceType: "unknown",
      reason: "not RevenueCat subscription shape",
      event,
    });
  }

  if (!looksLikeSubscription) {
    return buildRevenueCatParseResult({
      ok: false,
      sourceType: "revenuecat",
      reason: "RevenueCat event is not subscription",
      event,
    });
  }

  const platform = getRevenueCatPlatform(event);
  if (!["ios", "android"].includes(platform)) {
    return buildRevenueCatParseResult({
      ok: false,
      sourceType: "revenuecat",
      reason: `unsupported store: ${event.store || "unknown"}`,
      event,
      platform,
    });
  }

  return buildRevenueCatParseResult({
    ok: true,
    sourceType: "revenuecat",
    event,
    platform,
    value: parseRevenueCatEventSubscriptionPlan(event),
  });
}

function buildRevenueCatParseResult({
  ok,
  sourceType,
  reason,
  event,
  platform,
  value,
}) {
  const resolvedPlatform =
    platform || (event ? getRevenueCatPlatform(event) : undefined);

  return {
    ok,
    source_type: sourceType,
    reason,
    event,
    event_type: event?.type || null,
    store: event?.store || null,
    product_id: event?.new_product_id || event?.product_id || null,
    platform: resolvedPlatform,
    value,
  };
}

async function validateNativePlanWithRevenueCatInquiry(
  runtime,
  nativePlan,
  revenueCatEvent,
  platform
) {
  const nativeResult = parseNativeIapSubscriptionPlan(nativePlan);
  const revenueCatResult = {
    event: revenueCatEvent,
    platform: platform || getRevenueCatPlatform(revenueCatEvent),
    value: parseRevenueCatEventSubscriptionPlan(revenueCatEvent),
  };

  return validateNativeResultWithRevenueCatInquiry(
    runtime,
    nativeResult,
    revenueCatResult
  );
}

async function validateNativeResultWithRevenueCatInquiry(
  runtime,
  nativeResult,
  revenueCatResult
) {
  const normalizedNative = normalizeSubscriptionResult(nativeResult);
  const normalizedRevenueCat = normalizeSubscriptionResult(
    revenueCatResult?.value
  );
  const initialComparison = compareSubscriptionResults(
    normalizedNative,
    normalizedRevenueCat
  );
  const platform =
    revenueCatResult?.platform || getRevenueCatPlatform(revenueCatResult?.event);
  const baseResult = {
    result: "match",
    is_active: normalizedNative.isActive === true,
    platform,
    rechecked: false,
    diff: {},
  };

  if (initialComparison.isMatch) {
    return baseResult;
  }

  const inquiryComparison = await compareWithRevenueCatInquiry(
    runtime,
    normalizedNative,
    revenueCatResult
  );

  if (inquiryComparison.status === "match") {
    return {
      ...baseResult,
      result: "match-after-inquiry",
      rechecked: true,
      inquiry: inquiryComparison.value,
    };
  }

  if (inquiryComparison.status === "mismatch") {
    return {
      ...baseResult,
      result: "mismatch-after-revenue-inquiry",
      rechecked: true,
      diff: inquiryComparison.diff,
    };
  }

  return {
    ...baseResult,
    result: `revenue-inquiry-${inquiryComparison.status}`,
    rechecked: inquiryComparison.status !== "skipped",
    reason: inquiryComparison.reason,
    error: inquiryComparison.error,
  };
}

async function compareWithRevenueCatInquiry(
  runtime,
  nativeResult,
  revenueCatResult
) {
  if (!revenueCatResult?.event) {
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
      error: serializeInquiryError(error),
    };
  }
}

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
    value: parseRevenueCatEventSubscriptionPlan(event),
  };
}

function parseNativeIapSubscriptionPlan(plan) {
  const summary = plan?.summary || {};
  const entitlementId =
    plan?.platform === "android"
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

function parseRevenueCatEventSubscriptionPlan(event) {
  const entitlementId =
    normalizeIapProductId(event?.new_product_id) ||
    normalizeIapProductId(event?.entitlement_ids?.[0]) ||
    normalizeIapProductId(event?.entitlement_id) ||
    normalizeIapProductId(event?.product_id);
  const now = Date.now();

  if (event?.type === "EXPIRATION") {
    return {
      isActive: false,
      entitlementId,
      expiresDate: event.expiration_at_ms
        ? new Date(event.expiration_at_ms).toISOString()
        : null,
      message: "Subscription expired",
    };
  }

  if (event?.expiration_at_ms) {
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

  if (event?.type !== "CANCELLATION") {
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
      if (
        field === "isActive" &&
        isExpirationBoundaryWithinTolerance(
          normalizedNative.expiresDate,
          normalizedRevenueCat.expiresDate
        )
      ) {
        continue;
      }

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

function isExpirationBoundaryWithinTolerance(leftDate, rightDate) {
  if (!isDateWithinTolerance(leftDate, rightDate)) {
    return false;
  }

  return isDateNearNow(leftDate) || isDateNearNow(rightDate);
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

function isDateNearNow(value) {
  if (!value) {
    return false;
  }

  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    return false;
  }

  return Math.abs(time - Date.now()) <= EXPIRES_DATE_TOLERANCE_MS;
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

function serializeInquiryError(error) {
  return {
    status:
      error.response?.status || error.code || error.meta?.statusCode || null,
    data: error.response?.data || error.errors || error.meta?.body || null,
    message: error.message || "Unknown error",
  };
}

module.exports = {
  compareSubscriptionResults,
  getNativeIapSubscriptionFromMemberInfo,
  getRevenueCatPlatform,
  getRevenueCatSubscriptionFromMemberInfo,
  normalizeIapProductId,
  normalizeSubscriptionResult,
  parseNativeIapSubscriptionPlan,
  parseRevenueCatSubscriptionPlan,
  parseRevenueCatEventSubscriptionPlan,
  validateNativePlanWithRevenueCatInquiry,
  validateNativeResultWithRevenueCatInquiry,
};
