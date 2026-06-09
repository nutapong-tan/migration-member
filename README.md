# migration-member

Local one-time migration script for converting RevenueCat member `subscription_plan`
payloads into the same `native-iap` payload shape used by the member service's
iOS/Android native in-app flows.

## What It Does

- Reads active `members` from Elasticsearch.
- Skips records already using `type: "native-iap"`.
- Skips miniapp and non-renewing purchase payloads.
- Converts every RevenueCat subscription payload it finds.
- Calls Apple App Store Server API for iOS subscriptions.
- Calls Google Android Publisher API for Android subscriptions.
- Logs only the exact member fields that would be saved:

```json
{"tier":"vvip-annual","subscription_plan":"{\"type\":\"native-iap\",...}"}
```

This project is currently log-only. It does not update Elasticsearch.

There is a commented stage-2 draft in the script for writing mapped members into
`members-migration`. When enabled later, it will copy the full member document,
replace `tier` and `subscription_plan` with the mapped values, and add:

- `ref_tier`
- `ref_subscription_plan`
- `sync_date`

That stage-2 write block is still commented out.
The write target is `members-migration`, using the original member `_id` as the
document id so reruns replace the same migration document instead of creating
duplicates.

There is also a commented stage-3 draft for the final `members` update. Keep it
commented until the logs and `members-migration` documents are verified.

## Structure

```text
migration-member/
  scripts/
    revenuecat-native-iap-migration.js
    members-migration-subscription.js
  .env.uat
  .env.prod
  run.sh
```

Add future scripts under `scripts/<script-name>.js`.
They can be run with this pattern:

```bash
./run.sh sync:<script-name>:prod
./run.sh test:<script-name>:prod
```

For this migration, `revenuecat` maps to
`scripts/revenuecat-native-iap-migration.js`.

`subscription` maps to `scripts/members-migration-subscription.js` and validates the migrated documents in
`members-migration` by comparing:

- `subscription_plan` parsed as native IAP
- `ref_subscription_plan` parsed as RevenueCat

When those two values do not match, the checker uses only the RevenueCat-side
`ref_subscription_plan` payload to inquiry Apple/Google again, then compares
that latest inquiry result against the migrated native IAP value. If this second
comparison matches, the result is logged as `match-after-revenue-inquiry`.
The final summary is logged with the `ValidateMembersMigrationSubscription.summary`
tag.

The compared result follows the get-member-info subscription shape:
`isActive`, `entitlementId`, and `expiresDate`.

## Setup

```bash
cd /Users/nuttt/Desktop/Projects/scripts/migration-member
pnpm install
```

If you do not use pnpm:

```bash
npm install
```

## Required Files

These files should be in this project root:

- `.env.uat`
- `.env.prod`
- `AuthKey_8S4KJDKL9U.p8`
- `AppleRootCA-G3.cer`
- `android_payment_service_account.json`

The current `.env.uat` and `.env.prod` files were created from the original
local migration values. Before running PROD, confirm `.env.prod` points to the
correct PROD Elasticsearch, Apple, and Android credentials.

## Required Env

Elasticsearch, choose one:

- `ELASTICSEARCH_CLOUD_ID`
- `ELASTICSEARCH_API_KEY`

or:

- `ELASTICSEARCH_HOST`

Shared:

- `MERCHANT_ID`

Apple:

- `APPLE_ENV`
- `APPLE_KEY_ID`
- `APPLE_ISSUER_ID`
- `APPLE_BUNDLE_ID`
- `APPLE_APPLE_ID` required when `APPLE_ENV=PRODUCTION`
- `APPLE_PRIVATE_KEY_PATH`
- `APPLE_ROOT_CERT_PATH`
- `APPLE_ENABLE_ONLINE_CHECKS`

Android:

- `ANDROID_PACKAGE_NAME`
- `ANDROID_SERVICE_ACCOUNT_PATH`

## Commands

Syntax check every script under `scripts/`:

```bash
pnpm run check
```

Run UAT:

```bash
pnpm run sync:revenuecat:uat
```

Run PROD:

```bash
pnpm run sync:revenuecat:prod
```

Validate `members-migration` UAT:

```bash
pnpm run test:subscription:uat
```

Validate `members-migration` PROD:

```bash
pnpm run test:subscription:prod
```

Equivalent shell runner:

```bash
./run.sh sync:revenuecat:uat
./run.sh sync:revenuecat:prod
./run.sh test:subscription:uat
./run.sh test:subscription:prod
./run.sh check
```

Direct node commands:

```bash
node scripts/revenuecat-native-iap-migration.js --env=uat
node scripts/revenuecat-native-iap-migration.js --env=prod
node scripts/revenuecat-native-iap-migration.js --env-file=.env.uat
```

Every run is still log-only in this draft. The script does not update
Elasticsearch.

## Output

Successful conversion logs one line per member:

```text
SyncRevenueCatSubscriptionsToNativeIap.updateMember {"tier":"...","subscription_plan":"..."}
```

Skipped or failed members are logged with reasons. The final line contains a
summary with `scanned`, `skipped`, `mapped`, `errors`, and platform counts.
