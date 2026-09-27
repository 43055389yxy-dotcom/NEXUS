#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-deploy}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SOURCE_FUNCTION="${NEXUS_BROKER_FUNCTION_NAME:-TontianConsoleBroker}"
SOURCE_ROLE_NAME="TontianConsoleBrokerRole"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nexus-scheduled.XXXXXX")"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

require_command aws
require_command jq
require_command zip

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BRIDGE_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${SOURCE_ROLE_NAME}"
SOURCE_FUNCTION_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${SOURCE_FUNCTION}"

definitions() {
  cat <<'EOF'
support-billing|NexusSupportBillingScheduled|support-billing-handler.handler|NexusSupportBillingScheduleRole|nexus-support-billing-daily-check|nexus-support-billing-lambda|{"task":"support-billing"}
apn-monitor|NexusApnMonitorScheduled|apn-monitor-handler.handler|NexusApnMonitorScheduleRole|nexus-apn-status-monitor-daily|NexusApnMonitor|{"source":"nexus.apn-monitor","detail-type":"APN Status Monitor"}
credit-monitor|NexusCreditMonitorScheduled|credit-monitor-handler.handler|NexusCreditMonitorScheduleRole|nexus-credit-monitor-daily|NexusCreditMonitor|{"source":"nexus.credit-monitor","detail-type":"Credit Monitor"}
ou-automation|NexusOuAutomationScheduled|ou-automation-handler.handler|NexusOuAutomationScheduleRole|nexus-daily-ou-reconciliation|nexus-ou-lambda|
EOF
}

source_environment() {
  aws lambda get-function-configuration \
    --region "$AWS_REGION" \
    --function-name "$SOURCE_FUNCTION" \
    --query 'Environment.Variables' \
    --output json
}

environment_keys() {
  case "$1" in
    support-billing) printf '%s' '["ACCOUNTS_TABLE","GROUPS_TABLE","WECOM_SUPPORT_WEBHOOK_URL"]' ;;
    apn-monitor) printf '%s' '["ACCOUNTS_TABLE","GROUPS_TABLE","APN_MONITOR_TABLE","APN_ACCOUNT_ID","APN_PARTNER_REGION","WECOM_APN_WEBHOOK_URL","WECOM_SUPPORT_WEBHOOK_URL","WECOM_APN_WEBHOOK_SECRET_ID"]' ;;
    credit-monitor) printf '%s' '["ACCOUNTS_TABLE","GROUPS_TABLE","CREDIT_MONITOR_TABLE","WECOM_CREDIT_WEBHOOK_URL","WECOM_SUPPORT_WEBHOOK_URL","WECOM_CREDIT_WEBHOOK_SECRET_ID","WECOM_APN_WEBHOOK_SECRET_ID"]' ;;
    ou-automation) printf '%s' '["ACCOUNTS_TABLE","GROUPS_TABLE","OU_HISTORY_TABLE","OU_AUTOMATION_GROUP_NAMES"]' ;;
    *) echo "Unknown component: $1" >&2; exit 1 ;;
  esac
}

write_environment() {
  local component="$1" output="$2" source_json="$3" keys
  keys="$(environment_keys "$component")"
  jq --argjson allowed "$keys" --arg bridge "$BRIDGE_ROLE_ARN" \
    '{Variables: (with_entries(select(.key as $name | $allowed | index($name))) + {CROSS_ACCOUNT_BRIDGE_ROLE_ARN: $bridge})}' \
    <<<"$source_json" >"$output"
}

secret_arn() {
  local component="$1" source_json="$2" secret_id=""
  case "$component" in
    apn-monitor)
      secret_id="$(jq -r '.WECOM_APN_WEBHOOK_SECRET_ID // empty' <<<"$source_json")"
      ;;
    credit-monitor)
      secret_id="$(jq -r '.WECOM_CREDIT_WEBHOOK_SECRET_ID // .WECOM_APN_WEBHOOK_SECRET_ID // empty' <<<"$source_json")"
      ;;
  esac
  if [[ -n "$secret_id" ]]; then
    aws secretsmanager describe-secret --region "$AWS_REGION" --secret-id "$secret_id" --query ARN --output text
  fi
}

write_trust_policy() {
  local function_name="$1" output="$2"
  jq -n \
    --arg account "$ACCOUNT_ID" \
    --arg function_arn "arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${function_name}" \
    '{Version:"2012-10-17",Statement:[{Sid:"LambdaExecution",Effect:"Allow",Principal:{Service:"lambda.amazonaws.com"},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:SourceAccount":$account},ArnLike:{"aws:SourceArn":$function_arn}}}]}' \
    >"$output"
}

write_role_policy() {
  local component="$1" function_name="$2" source_json="$3" output="$4"
  local accounts_table groups_table monitor_table history_table logs_arn secret
  accounts_table="$(jq -r '.ACCOUNTS_TABLE // "TontianAwsAccessAccounts"' <<<"$source_json")"
  groups_table="$(jq -r '.GROUPS_TABLE // "TontianAwsAccessGroups"' <<<"$source_json")"
  monitor_table=""
  history_table="$(jq -r '.OU_HISTORY_TABLE // "TontianOuAutomationHistory"' <<<"$source_json")"
  case "$component" in
    apn-monitor) monitor_table="$(jq -r '.APN_MONITOR_TABLE // "TontianApnMonitor"' <<<"$source_json")" ;;
    credit-monitor) monitor_table="$(jq -r '.CREDIT_MONITOR_TABLE // "TontianCreditMonitor"' <<<"$source_json")" ;;
  esac
  logs_arn="arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:/aws/lambda/${function_name}:*"
  secret="$(secret_arn "$component" "$source_json")"

  jq -n \
    --arg component "$component" \
    --arg account_arn "arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${accounts_table}" \
    --arg group_arn "arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${groups_table}" \
    --arg monitor_arn "arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${monitor_table}" \
    --arg history_arn "arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${history_table}" \
    --arg logs_arn "$logs_arn" \
    --arg bridge_arn "$BRIDGE_ROLE_ARN" \
    --arg secret_arn "$secret" '
      def allow($sid; $actions; $resources): {Sid:$sid,Effect:"Allow",Action:$actions,Resource:$resources};
      {Version:"2012-10-17",Statement:(
        [
          allow("WriteOwnLogs";["logs:CreateLogStream","logs:PutLogEvents"];[$logs_arn]),
          allow("UseCrossAccountBridge";["sts:AssumeRole"];[$bridge_arn])
        ]
        + (if $component == "support-billing" then [
            allow("ReadAccountDirectory";["dynamodb:Scan"];[$account_arn,$group_arn]),
            allow("UpdateBillingSnapshot";["dynamodb:UpdateItem"];[$account_arn])
          ] elif $component == "apn-monitor" then [
            allow("ReadApnDirectory";["dynamodb:Scan"];[$account_arn,$group_arn]),
            allow("WriteApnMonitor";["dynamodb:Query","dynamodb:PutItem","dynamodb:BatchWriteItem"];[$monitor_arn])
          ] elif $component == "credit-monitor" then [
            allow("ReadCreditDirectory";["dynamodb:Scan"];[$account_arn,$group_arn]),
            allow("WriteCreditMonitor";["dynamodb:Query","dynamodb:PutItem","dynamodb:BatchWriteItem"];[$monitor_arn])
          ] elif $component == "ou-automation" then [
            allow("ReadOuDirectory";["dynamodb:Scan","dynamodb:GetItem"];[$account_arn,$group_arn]),
            allow("UpdateOuDirectory";["dynamodb:UpdateItem"];[$account_arn]),
            allow("WriteOuHistory";["dynamodb:PutItem","dynamodb:Query"];[$history_arn])
          ] else [] end)
        + (if ($secret_arn | length) > 0 then [allow("ReadNotificationSecret";["secretsmanager:GetSecretValue"];[$secret_arn])] else [] end)
      )}' >"$output"
}

ensure_role() {
  local component="$1" function_name="$2" role_name="$3" source_json="$4"
  local trust_file="$WORK_DIR/${component}-trust.json" policy_file="$WORK_DIR/${component}-policy.json"
  write_trust_policy "$function_name" "$trust_file"
  write_role_policy "$component" "$function_name" "$source_json" "$policy_file"

  if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$role_name" --policy-document "file://${trust_file}" >/dev/null
  else
    aws iam create-role --role-name "$role_name" --assume-role-policy-document "file://${trust_file}" >/dev/null
  fi
  aws iam put-role-policy --role-name "$role_name" --policy-name "${role_name}Access" --policy-document "file://${policy_file}" >/dev/null
}

update_bridge_trust() {
  local roles_json current updated output="$WORK_DIR/bridge-trust.json"
  roles_json="$(definitions | awk -F'|' -v account="$ACCOUNT_ID" '{printf "%s\"arn:aws:iam::%s:role/%s\"", sep, account, $4; sep=","}' | sed 's/^/[/' | sed 's/$/]/')"
  current="$(aws iam get-role --role-name "$SOURCE_ROLE_NAME" --query 'Role.AssumeRolePolicyDocument' --output json)"
  updated="$(jq --argjson principals "$roles_json" '
    .Statement = ([.Statement[] | select(.Sid != "NexusScheduledRoleBridge")] + [{
      Sid:"NexusScheduledRoleBridge",
      Effect:"Allow",
      Principal:{AWS:$principals},
      Action:"sts:AssumeRole"
    }])' <<<"$current")"
  jq . <<<"$updated" >"$output"
  aws iam update-assume-role-policy --role-name "$SOURCE_ROLE_NAME" --policy-document "file://${output}" >/dev/null
}

build_package() {
  local package_dir="$WORK_DIR/package"
  mkdir -p "$package_dir"
  cp infra/lambda/*.mjs "$package_dir/"
  (
    cd "$package_dir"
    zip -q -X "$WORK_DIR/nexus-scheduled.zip" ./*.mjs
  )
}

configure_function() {
  local component="$1" function_name="$2" handler="$3" role_name="$4" source_json="$5"
  local role_arn env_file="$WORK_DIR/${component}-environment.json"
  role_arn="arn:aws:iam::${ACCOUNT_ID}:role/${role_name}"
  write_environment "$component" "$env_file" "$source_json"

  if aws lambda get-function --region "$AWS_REGION" --function-name "$function_name" >/dev/null 2>&1; then
    aws lambda update-function-code --region "$AWS_REGION" --function-name "$function_name" --zip-file "fileb://${WORK_DIR}/nexus-scheduled.zip" >/dev/null
    aws lambda wait function-updated --region "$AWS_REGION" --function-name "$function_name"
    aws lambda update-function-configuration \
      --region "$AWS_REGION" \
      --function-name "$function_name" \
      --runtime nodejs22.x \
      --handler "$handler" \
      --role "$role_arn" \
      --timeout 900 \
      --memory-size 256 \
      --environment "file://${env_file}" \
      >/dev/null
  else
    local created=false
    for attempt in 1 2 3 4 5 6; do
      if aws lambda create-function \
        --region "$AWS_REGION" \
        --function-name "$function_name" \
        --runtime nodejs22.x \
        --handler "$handler" \
        --role "$role_arn" \
        --zip-file "fileb://${WORK_DIR}/nexus-scheduled.zip" \
        --timeout 900 \
        --memory-size 256 \
        --architectures arm64 \
        --environment "file://${env_file}" \
        --description "NEXUS isolated ${component} schedule" \
        --tags "Application=NEXUS,Component=${component},ManagedBy=infra-script" \
        >/dev/null; then
        created=true
        break
      fi
      sleep 5
    done
    [[ "$created" == true ]] || { echo "Failed to create Lambda: $function_name" >&2; exit 1; }
  fi

  aws lambda wait function-updated --region "$AWS_REGION" --function-name "$function_name"
  aws logs create-log-group --region "$AWS_REGION" --log-group-name "/aws/lambda/${function_name}" >/dev/null 2>&1 || true
  aws logs put-retention-policy --region "$AWS_REGION" --log-group-name "/aws/lambda/${function_name}" --retention-in-days 30

  local response="$WORK_DIR/${component}-health.json"
  aws lambda invoke \
    --region "$AWS_REGION" \
    --function-name "$function_name" \
    --cli-binary-format raw-in-base64-out \
    --payload '{"healthcheck":true}' \
    "$response" \
    >/dev/null
  jq -e '.ok == true and (.missingEnvironment | length == 0)' "$response" >/dev/null
  aws lambda invoke \
    --region "$AWS_REGION" \
    --function-name "$function_name" \
    --cli-binary-format raw-in-base64-out \
    --payload '{"bridgeHealthcheck":true}' \
    "$response" \
    >/dev/null
  jq -e --arg account "$ACCOUNT_ID" '.ok == true and .bridge.mode == "bridge" and .bridge.account == $account and .bridge.role == "TontianConsoleBrokerRole"' "$response" >/dev/null
  echo "Healthy: $function_name"
}

deploy_all() {
  local source_json
  source_json="$(source_environment)"
  build_package
  while IFS='|' read -r component function_name handler role_name _rule _target _input; do
    ensure_role "$component" "$function_name" "$role_name" "$source_json"
  done < <(definitions)
  update_bridge_trust
  while IFS='|' read -r component function_name handler role_name _rule _target _input; do
    configure_function "$component" "$function_name" "$handler" "$role_name" "$source_json"
  done < <(definitions)
}

set_targets() {
  local destination="$1"
  while IFS='|' read -r component function_name _handler _role_name rule target_id input; do
    local function_arn rule_arn target_file="$WORK_DIR/${component}-target.json" statement_id
    if [[ "$destination" == "new" ]]; then
      function_arn="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${function_name}"
      rule_arn="$(aws events describe-rule --region "$AWS_REGION" --name "$rule" --query Arn --output text)"
      statement_id="Allow-${rule}"
      aws lambda remove-permission --region "$AWS_REGION" --function-name "$function_name" --statement-id "$statement_id" >/dev/null 2>&1 || true
      aws lambda add-permission \
        --region "$AWS_REGION" \
        --function-name "$function_name" \
        --statement-id "$statement_id" \
        --action lambda:InvokeFunction \
        --principal events.amazonaws.com \
        --source-arn "$rule_arn" \
        >/dev/null
    else
      function_arn="$SOURCE_FUNCTION_ARN"
    fi

    if [[ -n "$input" ]]; then
      jq -n --arg id "$target_id" --arg arn "$function_arn" --arg input "$input" '[{Id:$id,Arn:$arn,Input:$input}]' >"$target_file"
    else
      jq -n --arg id "$target_id" --arg arn "$function_arn" '[{Id:$id,Arn:$arn}]' >"$target_file"
    fi
    aws events put-targets --region "$AWS_REGION" --rule "$rule" --targets "file://${target_file}" >/dev/null
    echo "Target ${rule} -> ${function_arn##*:}"
  done < <(definitions)
}

show_status() {
  while IFS='|' read -r component function_name _handler role_name rule _target _input; do
    local target
    target="$(aws events list-targets-by-rule --region "$AWS_REGION" --rule "$rule" --query 'Targets[0].Arn' --output text)"
    printf '%-18s function=%-36s role=%-34s target=%s\n' "$component" "$function_name" "$role_name" "${target##*:}"
  done < <(definitions)
}

case "$MODE" in
  deploy)
    deploy_all
    show_status
    ;;
  cutover)
    deploy_all
    set_targets new
    show_status
    ;;
  rollback)
    set_targets old
    show_status
    ;;
  status)
    show_status
    ;;
  *)
    echo "Usage: $0 [deploy|cutover|rollback|status]" >&2
    exit 2
    ;;
esac
