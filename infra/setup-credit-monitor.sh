#!/usr/bin/env bash
set -Eeuo pipefail

FUNCTION_NAME="${1:-TontianConsoleBroker}"
REGION="${2:-us-east-1}"
TABLE_NAME="${CREDIT_MONITOR_TABLE:-TontianCreditMonitor}"
RULE_NAME="nexus-credit-monitor-daily"
STATEMENT_ID="NexusCreditMonitorSchedule"
export AWS_PAGER=""

if ! aws dynamodb describe-table --region "$REGION" --table-name "$TABLE_NAME" >/dev/null 2>&1; then
  aws dynamodb create-table --region "$REGION" --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --region "$REGION" --table-name "$TABLE_NAME"
fi

FUNCTION_ARN="$(aws lambda get-function --region "$REGION" --function-name "$FUNCTION_NAME" --query 'Configuration.FunctionArn' --output text)"
ROLE_ARN="$(aws lambda get-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" --query Role --output text)"
ROLE_NAME="${ROLE_ARN##*/}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

cat >/tmp/nexus-credit-monitor-storage-policy.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["dynamodb:Query","dynamodb:PutItem","dynamodb:BatchWriteItem"],"Resource":"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}"},{"Effect":"Allow","Action":"sts:AssumeRole","Resource":"arn:aws:iam::*:role/TontianOperationsRole"}]}
EOF
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name NexusCreditMonitor --policy-document file:///tmp/nexus-credit-monitor-storage-policy.json

CURRENT_ENV="$(aws lambda get-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" --query 'Environment.Variables' --output json)"
UPDATED_ENV="$(printf '%s' "$CURRENT_ENV" | jq -c --arg table "$TABLE_NAME" '{Variables:(. + {CREDIT_MONITOR_TABLE:$table})}')"
aws lambda update-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" --environment "$UPDATED_ENV" >/dev/null
aws lambda wait function-updated --region "$REGION" --function-name "$FUNCTION_NAME"

RULE_ARN="$(aws events put-rule --region "$REGION" --name "$RULE_NAME" --schedule-expression 'rate(1 hour)' --state ENABLED --description 'NEXUS credit monitor every hour' --query RuleArn --output text)"
cat >/tmp/nexus-credit-monitor-targets.json <<EOF
[{"Id":"NexusCreditMonitor","Arn":"${FUNCTION_ARN}","Input":"{\"source\":\"nexus.credit-monitor\",\"detail-type\":\"Credit Monitor\"}"}]
EOF
aws events put-targets --region "$REGION" --rule "$RULE_NAME" --targets file:///tmp/nexus-credit-monitor-targets.json >/dev/null
aws lambda remove-permission --region "$REGION" --function-name "$FUNCTION_NAME" --statement-id "$STATEMENT_ID" >/dev/null 2>&1 || true
aws lambda add-permission --region "$REGION" --function-name "$FUNCTION_NAME" --statement-id "$STATEMENT_ID" --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn "$RULE_ARN" >/dev/null

echo "代金券监控已启用：每小时自动同步"
