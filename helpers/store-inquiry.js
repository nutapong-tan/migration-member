const fs = require("fs");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");
const {
  Environment,
  SignedDataVerifier,
} = require("@apple/app-store-server-library");
const { requiredEnv, resolvePath } = require("./env");

const DEFAULT_ANDROID_PACKAGE_NAME = "com.bessoga.reelike.android";

function createAppleContextGetter() {
  let appleContext = null;

  return function getAppleContext() {
    const shouldCreateToken =
      !appleContext || appleContext.tokenExpiresAtMs < Date.now() + 60_000;
    if (!shouldCreateToken) {
      return appleContext;
    }

    const environmentName =
      this.appleEnv === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
    const environment =
      environmentName === "PRODUCTION"
        ? Environment.PRODUCTION
        : Environment.SANDBOX;
    const baseUrl =
      environmentName === "PRODUCTION"
        ? "https://api.storekit.apple.com"
        : "https://api.storekit-sandbox.apple.com";
    const bundleId = requiredEnv("APPLE_BUNDLE_ID");
    const appAppleId =
      environmentName === "PRODUCTION"
        ? Number(requiredEnv("APPLE_APPLE_ID"))
        : undefined;

    if (appAppleId !== undefined && !Number.isFinite(appAppleId)) {
      throw new Error("APPLE_APPLE_ID must be a number");
    }

    const privateKey = fs.readFileSync(
      resolvePath(requiredEnv("APPLE_PRIVATE_KEY_PATH")),
      "utf8"
    );
    const rootCert = fs.readFileSync(
      resolvePath(requiredEnv("APPLE_ROOT_CERT_PATH"))
    );
    const verifier = new SignedDataVerifier(
      [rootCert],
      process.env.APPLE_ENABLE_ONLINE_CHECKS?.toLowerCase() === "true",
      environment,
      bundleId,
      appAppleId
    );
    const now = Math.floor(Date.now() / 1000);
    const expiresInSeconds = 20 * 60;
    const token = jwt.sign(
      {
        iss: requiredEnv("APPLE_ISSUER_ID"),
        iat: now,
        exp: now + expiresInSeconds,
        aud: "appstoreconnect-v1",
        bid: bundleId,
      },
      privateKey,
      {
        algorithm: "ES256",
        header: {
          alg: "ES256",
          kid: requiredEnv("APPLE_KEY_ID"),
          typ: "JWT",
        },
      }
    );

    appleContext = {
      baseUrl,
      environmentName,
      jwt: token,
      tokenExpiresAtMs: (now + expiresInSeconds) * 1000,
      verifier,
    };

    return appleContext;
  };
}

function createAndroidPublisherGetter() {
  let androidPublisher = null;

  return function getAndroidPublisher() {
    if (androidPublisher) {
      return androidPublisher;
    }

    const serviceAccountPath = resolvePath(
      requiredEnv("ANDROID_SERVICE_ACCOUNT_PATH")
    );
    if (!fs.existsSync(serviceAccountPath)) {
      throw new Error(`Service account file not found: ${serviceAccountPath}`);
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: serviceAccountPath,
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
    androidPublisher = google.androidpublisher({ version: "v3", auth });

    return androidPublisher;
  };
}

async function buildNativePlanFromRevenueCatEvent(runtime, platform, event) {
  if (platform === "ios") {
    return buildIosNativePlanFromRevenueCatEvent(runtime, event);
  }

  return buildAndroidNativePlanFromRevenueCatEvent(runtime, event);
}

async function buildIosNativePlanFromRevenueCatEvent(runtime, event) {
  const apple = runtime.getAppleContext();
  const originalTransactionId = String(
    event.original_transaction_id || event.transaction_id || ""
  ).trim();

  if (!originalTransactionId) {
    throw new Error("RevenueCat iOS event missing original_transaction_id");
  }

  const response = await axios.get(
    `${apple.baseUrl}/inApps/v1/subscriptions/${originalTransactionId}`,
    {
      headers: { Authorization: `Bearer ${apple.jwt}` },
      timeout: 15000,
    }
  );
  const statusResponse = response.data;
  const groups = Array.isArray(statusResponse?.data) ? statusResponse.data : [];
  const transactionGroups = groups.map((group) =>
    Array.isArray(group?.lastTransactions) ? group.lastTransactions : []
  );
  const matchingGroup =
    transactionGroups.find((transactions) =>
      transactions.some(
        (item) => item?.originalTransactionId === originalTransactionId
      )
    ) ||
    transactionGroups.find((transactions) => transactions.length > 0) ||
    [];
  const latestTransaction =
    matchingGroup.find((item) => item?.status === 1) ||
    matchingGroup.find(
      (item) => item?.originalTransactionId === originalTransactionId
    ) ||
    matchingGroup[0] ||
    null;
  const verifiedTransaction = latestTransaction?.signedTransactionInfo
    ? await apple.verifier.verifyAndDecodeTransaction(
        latestTransaction.signedTransactionInfo
      )
    : null;
  const verifiedRenewalInfo = latestTransaction?.signedRenewalInfo
    ? await apple.verifier.verifyAndDecodeRenewalInfo(
        latestTransaction.signedRenewalInfo
      )
    : null;

  if (!verifiedTransaction) {
    throw new Error("Apple subscription response has no verified transaction");
  }

  return {
    statusResponse,
    latestTransaction,
    verifiedTransaction,
    verifiedRenewalInfo,
    summary: {
      status: latestTransaction?.status ?? null,
      statusLabel:
        {
          1: "ACTIVE",
          2: "EXPIRED",
          3: "BILLING_RETRY",
          4: "BILLING_GRACE_PERIOD",
          5: "REVOKED",
        }[latestTransaction?.status] || "UNKNOWN",
      originalTransactionId:
        latestTransaction?.originalTransactionId?.trim() ||
        verifiedTransaction?.originalTransactionId?.trim() ||
        null,
      productId: verifiedTransaction?.productId?.trim() || null,
      autoRenewProductId:
        verifiedRenewalInfo?.autoRenewProductId?.trim() || null,
      expiresDate: numberOrNull(verifiedTransaction?.expiresDate),
      gracePeriodExpiresDate: numberOrNull(
        verifiedRenewalInfo?.gracePeriodExpiresDate
      ),
      renewalDate: numberOrNull(verifiedRenewalInfo?.renewalDate),
      autoRenewStatus: verifiedRenewalInfo?.autoRenewStatus ?? null,
      appAccountToken:
        verifiedRenewalInfo?.appAccountToken?.trim() ||
        verifiedTransaction?.appAccountToken?.trim() ||
        null,
      environment:
        verifiedRenewalInfo?.environment?.trim() ||
        verifiedTransaction?.environment?.trim() ||
        null,
    },
    type: "native-iap",
    platform: "ios",
  };
}

async function buildAndroidNativePlanFromRevenueCatEvent(runtime, event) {
  const publisher = runtime.getAndroidPublisher();
  const packageName = runtime.androidPackageName.trim();
  const orderId = String(
    event.original_transaction_id || event.transaction_id || ""
  ).trim();
  const webhookProductId = String(
    event.new_product_id || event.product_id || ""
  ).trim();
  const [fallbackProductId, fallbackBasePlanId = null] =
    webhookProductId.split(":");
  let orderResponse = null;
  let purchaseToken = String(
    event.purchase_token || event.purchaseToken || ""
  ).trim();

  if (!packageName) {
    throw new Error("Missing Android package name");
  }

  if (!purchaseToken) {
    if (!orderId) {
      throw new Error("RevenueCat Android event missing order id and purchase token");
    }

    orderResponse = (
      await publisher.orders.get({
        packageName,
        orderId,
      })
    ).data;
    purchaseToken = orderResponse?.purchaseToken || "";
  }

  if (!purchaseToken) {
    throw new Error("Google order response has no purchaseToken");
  }

  const response = await publisher.purchases.subscriptionsv2.get({
    packageName,
    token: purchaseToken,
  });
  const googleResponse = response.data;
  const lineItem = Array.isArray(googleResponse.lineItems)
    ? googleResponse.lineItems[0]
    : null;
  const orderLineItem = Array.isArray(orderResponse?.lineItems)
    ? orderResponse.lineItems[0]
    : null;
  const productId =
    lineItem?.productId || orderLineItem?.productId || fallbackProductId || "";
  const basePlanId =
    lineItem?.offerDetails?.basePlanId ||
    orderLineItem?.subscriptionDetails?.basePlanId ||
    fallbackBasePlanId;
  const expiresDate = lineItem?.expiryTime
    ? new Date(lineItem.expiryTime).getTime()
    : null;
  const isAutoRenewEnabled = !!lineItem?.autoRenewingPlan?.autoRenewEnabled;
  const isExpired =
    googleResponse.subscriptionState === "SUBSCRIPTION_STATE_ACTIVE" &&
    typeof expiresDate === "number" &&
    expiresDate < Date.now();
  const validGoogleStates = [
    "SUBSCRIPTION_STATE_UNSPECIFIED",
    "SUBSCRIPTION_STATE_PENDING",
    "SUBSCRIPTION_STATE_ACTIVE",
    "SUBSCRIPTION_STATE_PAUSED",
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
    "SUBSCRIPTION_STATE_ON_HOLD",
    "SUBSCRIPTION_STATE_CANCELED",
    "SUBSCRIPTION_STATE_EXPIRED",
  ];
  const statusLabel = isExpired
    ? "SUBSCRIPTION_STATE_EXPIRED"
    : validGoogleStates.includes(googleResponse.subscriptionState)
      ? googleResponse.subscriptionState
      : "UNKNOWN";

  return {
    verifiedTransaction: {
      transactionId: purchaseToken,
      productId,
      purchaseDate: googleResponse.startTime
        ? new Date(googleResponse.startTime).getTime()
        : undefined,
      type: "Auto-Renewable Subscription",
      purchaseToken,
      storefrontId: googleResponse.regionCode ?? undefined,
    },
    summary: {
      status:
        googleResponse.subscriptionState === "SUBSCRIPTION_STATE_ACTIVE" &&
        !isExpired
          ? 1
          : 0,
      statusLabel,
      purchaseToken,
      productId,
      basePlanId,
      autoRenewProductId: isAutoRenewEnabled ? productId : "",
      expiresDate,
      gracePeriodExpiresDate: null,
      renewalDate: expiresDate,
      autoRenewStatus: isAutoRenewEnabled ? 1 : 0,
      appAccountToken: null,
      environment: googleResponse.testPurchase ? "Sandbox" : "Production",
    },
    type: "native-iap",
    platform: "android",
  };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

module.exports = {
  DEFAULT_ANDROID_PACKAGE_NAME,
  buildNativePlanFromRevenueCatEvent,
  createAndroidPublisherGetter,
  createAppleContextGetter,
};
