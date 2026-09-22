#!/usr/bin/env bash
set -Eeuo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
FUNCTION_NAME="${NEXUS_BROKER_FUNCTION_NAME:-TontianConsoleBroker}"
PACKAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nexus-broker.XXXXXX")"

cleanup() {
  rm -rf "$PACKAGE_DIR"
}
trap cleanup EXIT

cp infra/lambda/*.mjs "$PACKAGE_DIR/"
(
  cd "$PACKAGE_DIR"
  zip -q -X broker.zip ./*.mjs
)

aws lambda update-function-code \
  --region "$AWS_REGION" \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$PACKAGE_DIR/broker.zip" \
  --no-cli-pager \
  >/dev/null

aws lambda wait function-updated \
  --region "$AWS_REGION" \
  --function-name "$FUNCTION_NAME"

read -r state update_status < <(
  aws lambda get-function-configuration \
    --region "$AWS_REGION" \
    --function-name "$FUNCTION_NAME" \
    --query '[State,LastUpdateStatus]' \
    --output text
)

if [[ "$state" != "Active" || "$update_status" != "Successful" ]]; then
  echo "Lambda deployment did not become healthy: state=$state update=$update_status" >&2
  exit 1
fi

echo "Lambda deployment succeeded: $FUNCTION_NAME"
