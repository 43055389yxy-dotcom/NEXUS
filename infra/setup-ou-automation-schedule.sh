#!/bin/sh
set -eu

FUNCTION_NAME="${1:?用法: sh infra/setup-ou-automation-schedule.sh <Lambda函数名> [区域]}"
REGION="${2:-us-east-1}"
RULE_NAME="nexus-daily-ou-reconciliation"
STATEMENT_ID="nexus-daily-ou-reconciliation"

FUNCTION_ARN="$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --region "$REGION" --query FunctionArn --output text)"
EXECUTION_ROLE_ARN="$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --region "$REGION" --query Role --output text)"
EXECUTION_ROLE_NAME="${EXECUTION_ROLE_ARN##*/}"

cat >/tmp/nexus-ou-assume-role-policy.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Resource":"arn:aws:iam::*:role/TontianOrganizationAutomationRole"}]}
JSON
aws iam put-role-policy --role-name "$EXECUTION_ROLE_NAME" --policy-name NexusOuAutomationAssumeRole --policy-document file:///tmp/nexus-ou-assume-role-policy.json

RULE_ARN="$(aws events put-rule --name "$RULE_NAME" --schedule-expression 'cron(0 18 * * ? *)' --state ENABLED --description 'NEXUS daily OU reconciliation at 02:00 Asia/Shanghai' --region "$REGION" --query RuleArn --output text)"
if ! aws lambda get-policy --function-name "$FUNCTION_NAME" --region "$REGION" --query Policy --output text 2>/dev/null | grep -q "$STATEMENT_ID"; then
  aws lambda add-permission --function-name "$FUNCTION_NAME" --statement-id "$STATEMENT_ID" --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn "$RULE_ARN" --region "$REGION" >/dev/null
fi
aws events put-targets --rule "$RULE_NAME" --targets "Id"="nexus-ou-lambda","Arn"="$FUNCTION_ARN" --region "$REGION" >/dev/null
echo "已配置：每天北京时间 02:00 执行 OU 归位"
