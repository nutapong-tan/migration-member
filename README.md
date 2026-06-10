# migration-member

Local one-time migration script for converting RevenueCat member `subscription_plan`
payloads into the same `native-iap` payload shape used by the member service's
iOS/Android native in-app flows.

## What It Does

- Reads all `members` that have `subscription_plan` from Elasticsearch.
- Skips records already using `type: "native-iap"`.
- Skips miniapp and non-renewing purchase payloads.
- Converts every RevenueCat subscription payload it finds.
- Calls Apple App Store Server API for iOS subscriptions.
- Calls Google Android Publisher API for Android subscriptions.
- Updates `tier` only from the active native subscription returned by
  Apple/Google using the same `member_tiers` label/prefix mapping behavior as
  `olst-ms-member`; inactive subscription results update `subscription_plan` only.
- Logs only the exact member fields that would be saved:

```json
{"tier":"vvip-annual","subscription_plan":"{\"type\":\"native-iap\",...}"}
```

This project writes mapped members into `members-migration` only. It does not
update the real `members` index.

The migration write copies the full member document, replaces `tier` and
`subscription_plan` with the mapped values, and adds:

- `ref_tier`
- `ref_subscription_plan`
- `sync_date`
- `tag`

The `tag` is built once per run from the local date and time in
`YYYYMMDD-HHmmss` format.
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
```

Add future scripts under `scripts/<script-name>.js`.

For this migration, `revenuecat` maps to
`scripts/revenuecat-native-iap-migration.js`.

`subscription` maps to `scripts/members-migration-subscription.js` and validates the migrated documents in
`members-migration` by comparing:

- `subscription_plan` parsed as native IAP
- `ref_subscription_plan` parsed as RevenueCat

When those two values do not match, the checker uses only the RevenueCat-side
`ref_subscription_plan` payload to inquiry Apple/Google again, then compares
that latest inquiry result against the migrated native IAP value. If this second
comparison matches, the result is logged as `match-after-inquiry`.
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

Report current `members.subscription_plan` type counts:

```bash
pnpm run report:member-types:uat
pnpm run report:member-types:prod
```

The report scans current `members` documents that have `subscription_plan`, then
groups them into `revenuecat`, `native-iap`, `miniapp`, `unknown`, plus
empty/invalid JSON counts. Add `--include-missing`, `--active-only`, or
`--untransferred-only` after `--` if you want to adjust the scan.
Use `--details=revenuecat` to list the remaining RevenueCat documents, or
`--json` to print the raw JSON summary.

Revert `members` values from a `members-migration` tag:

```bash
pnpm run revert:members:uat -- --tag=20260610-153012
pnpm run revert:members:prod -- --tag=20260610-153012
```

The revert command reads `members-migration` documents with the given `tag`,
restores `members.tier` from `ref_tier`, restores `members.subscription_plan`
from `ref_subscription_plan`, and deletes each successfully restored
`members-migration` document.

Every run writes mapped documents to `members-migration`. The script does not
update the real `members` index.

## Output

Successful conversion logs one line per member:

```text
SyncRevenueCatSubscriptionsToNativeIap.updateMember {"tier":"...","subscription_plan":"..."}
```

Skipped or failed members are logged with reasons. The final line contains a
summary with `scanned`, `skipped`, `mapped`, `errors`, and platform counts.
