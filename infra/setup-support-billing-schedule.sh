#!/bin/sh
set -eu

FUNCTION_NAME="${1:?用法: sh infra/setup-support-billing-schedule.sh <Lambda函数名> [区域]}"
REGION="${2:-us-east-1}"
RULE_NAME="nexus-support-billing-daily-check"
STATEMENT_ID="nexus-support-billing-daily-check"

FUNCTION_ARN="$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --region "$REGION" --query FunctionArn --output text)"
EXECUTION_ROLE_ARN="$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --region "$REGION" --query Role --output text)"
EXECUTION_ROLE_NAME="${EXECUTION_ROLE_ARN##*/}"

cat >/tmp/nexus-support-billing-assume-role-policy.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Resource":"arn:aws:iam::*:role/TontianOrganizationAutomationRole"}]}
JSON
aws iam put-role-policy --role-name "$EXECUTION_ROLE_NAME" --policy-name NexusSupportBillingAssumeRole --policy-document file:///tmp/nexus-support-billing-assume-role-policy.json

RULE_ARN="$(aws events put-rule --name "$RULE_NAME" --schedule-expression 'cron(15 2,18,22 * * ? *)' --state ENABLED --description 'NEXUS Support billing at 02:15 with 06:15 and 10:15 retries when incomplete' --region "$REGION" --query RuleArn --output text)"
if ! aws lambda get-policy --function-name "$FUNCTION_NAME" --region "$REGION" --query Policy --output text 2>/dev/null | grep -q "$STATEMENT_ID"; then
  aws lambda add-permission --function-name "$FUNCTION_NAME" --statement-id "$STATEMENT_ID" --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn "$RULE_ARN" --region "$REGION" >/dev/null
fi
cat >/tmp/nexus-support-billing-targets.json <<JSON
[{"Id":"nexus-support-billing-lambda","Arn":"$FUNCTION_ARN","Input":"{\"task\":\"support-billing\"}"}]
JSON
aws events put-targets --rule "$RULE_NAME" --targets file:///tmp/nexus-support-billing-targets.json --region "$REGION" >/dev/null
echo "已配置：Support 对账北京时间 02:15 判断；数据不完整时 06:15、10:15 自动重试；平时每 3 天执行，月末最后 3 天每天检查本月，次月前 10 天每天复查上月和本月"
