#!/bin/sh
set -eu

export AWS_PAGER=""
export AWS_CLI_AUTO_PROMPT=off

OPS_ACCOUNT_ID="590184009438"
CALLER_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --cli-connect-timeout 5 --cli-read-timeout 10)"
if [ "$CALLER_ACCOUNT_ID" != "$OPS_ACCOUNT_ID" ]; then
  printf '%s\n' "Run this script from operations account $OPS_ACCOUNT_ID." >&2
  exit 1
fi

# This additive deny protects existing payer roles without replacing other policies.
aws iam put-role-policy \
  --role-name TontianConsoleBrokerRole \
  --policy-name NexusDenyHighestAdminAccess \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Sid":"DenyAssumingHighestAdmin","Effect":"Deny","Action":"sts:AssumeRole","Resource":["arn:aws:iam::*:role/TontianAdminRole","arn:aws:iam::*:role/*/TontianAdminRole"]}]}' \
  --cli-connect-timeout 5 --cli-read-timeout 10

printf '%s\n' 'Applied: TontianConsoleBrokerRole cannot assume TontianAdminRole.'
