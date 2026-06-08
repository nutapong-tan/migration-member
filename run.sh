#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

command_name="${1:-sync:revenuecat-native:uat}"

if [[ "$command_name" == "check" ]]; then
  for file in scripts/*.js; do
    node --check "$file"
  done
  exit 0
fi

IFS=":" read -r command_prefix script_name script_env <<< "$command_name"

if [[ "$command_prefix" != "sync" ]]; then
  echo "Invalid command: ${command_prefix:-}"
  echo "Use sync. Example: sync:revenuecat-native:uat"
  exit 1
fi

if [[ "$script_env" != "uat" && "$script_env" != "prod" ]]; then
  echo "Invalid env: ${script_env:-}"
  echo "Use uat or prod. Example: sync:revenuecat-native:prod"
  exit 1
fi

case "$script_name" in
  revenuecat-native)
    script_file="revenuecat-native-iap-migration.js"
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

node "$script_path" --env="$script_env"
