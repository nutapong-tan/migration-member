#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

command_name="${1:-sync:revenuecat:uat}"

if [[ "$command_name" == "check" ]]; then
  for file in scripts/*.js; do
    node --check "$file"
  done
  exit 0
fi

IFS=":" read -r command_prefix script_name script_env <<< "$command_name"

if [[ "$command_prefix" != "sync" && "$command_prefix" != "test" && "$command_prefix" != "report" && "$command_prefix" != "revert" ]]; then
  echo "Invalid command: ${command_prefix:-}"
  echo "Use sync, test, report, or revert. Example: revert:members:uat"
  exit 1
fi

if [[ "$script_env" != "uat" && "$script_env" != "prod" ]]; then
  echo "Invalid env: ${script_env:-}"
  echo "Use uat or prod. Example: test:subscription:prod"
  exit 1
fi

case "$script_name" in
  revenuecat)
    script_file="revenuecat-native-iap-migration.js"
    ;;
  subscription)
    script_file="members-migration-subscription.js"
    ;;
  member-types)
    script_file="member-subscription-type-report.js"
    ;;
  members)
    if [[ "$command_prefix" == "revert" ]]; then
      script_file="revert-members-from-migration-tag.js"
    else
      script_file="${script_name}.js"
    fi
    ;;
  *)
    script_file="${script_name}.js"
    ;;
esac

script_path="scripts/${script_file}"

if [[ ! -f "$script_path" ]]; then
  echo "Script not found: $script_path"
  echo "Available script files:"
  for file in scripts/*.js; do
    basename "$file"
  done
  exit 1
fi

node "$script_path" --env="$script_env" "${@:2}"
