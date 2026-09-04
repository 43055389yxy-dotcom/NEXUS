#!/bin/sh
set -eu

REGION="${1:-us-east-1}"
TABLE_NAME="${OU_HISTORY_TABLE:-TontianOuAutomationHistory}"
ROLE_NAME="${OU_LAMBDA_ROLE:-TontianConsoleBrokerRole}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

if ! aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=payerAccountId,AttributeType=S AttributeName=occurredAtId,AttributeType=S \
    --key-schema AttributeName=payerAccountId,KeyType=HASH AttributeName=occurredAtId,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE_NAME" --region "$REGION"
fi

TTL_STATUS="$(aws dynamodb describe-time-to-live --table-name "$TABLE_NAME" --region "$REGION" --query 'TimeToLiveDescription.TimeToLiveStatus' --output text)"
if [ "$TTL_STATUS" != "ENABLED" ] && [ "$TTL_STATUS" != "ENABLING" ]; then
  aws dynamodb update-time-to-live --table-name "$TABLE_NAME" --time-to-live-specification Enabled=true,AttributeName=expiresAt --region "$REGION" >/dev/null
fi

cat >/tmp/nexus-ou-history-policy.json <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["dynamodb:PutItem","dynamodb:Query"],"Resource":"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}"}]}
JSON
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name NexusOuAutomationHistory --policy-document file:///tmp/nexus-ou-history-policy.json
echo "OU 移动历史表已配置：${TABLE_NAME}"
