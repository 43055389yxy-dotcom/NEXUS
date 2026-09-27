#!/usr/bin/env bash
set -Eeuo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
FUNCTION_NAME="${NEXUS_BROKER_FUNCTION_NAME:-TontianConsoleBroker}"
ROLE_NAME="${NEXUS_BROKER_ROLE_NAME:-TontianConsoleBrokerRole}"
SECRET_ID="${NEXUS_BROKER_SECRET_ID:-nexus/internal-api-key}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nexus-broker-secret.XXXXXX")"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

SECRET_ARN="$(aws secretsmanager describe-secret \
  --region "$AWS_REGION" \
  --secret-id "$SECRET_ID" \
  --query ARN \
  --output text)"

jq -n --arg arn "$SECRET_ARN" '{
  Version: "2012-10-17",
  Statement: [{
    Sid: "ReadNexusInternalApiKey",
    Effect: "Allow",
    Action: "secretsmanager:GetSecretValue",
    Resource: $arn
  }]
}' >"$WORK_DIR/policy.json"

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name NexusInternalApiKeyRead \
  --policy-document "file://$WORK_DIR/policy.json" \
  >/dev/null

aws lambda get-function-configuration \
  --region "$AWS_REGION" \
  --function-name "$FUNCTION_NAME" \
  --query 'Environment.Variables' \
  --output json \
  | jq --arg secret_id "$SECRET_ID" '{Variables: (del(.INTERNAL_API_KEY) + {INTERNAL_API_KEY_SECRET_ID: $secret_id})}' \
  >"$WORK_DIR/environment.json"

aws lambda update-function-configuration \
  --region "$AWS_REGION" \
  --function-name "$FUNCTION_NAME" \
  --environment "file://$WORK_DIR/environment.json" \
  >/dev/null

aws lambda wait function-updated \
  --region "$AWS_REGION" \
  --function-name "$FUNCTION_NAME"

echo "Configured $FUNCTION_NAME to read its internal API key from Secrets Manager."
