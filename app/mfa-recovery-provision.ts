export const CENTRALIZED_ROOT_ACCESS_SETUP_COMMAND = `export AWS_PAGER=""

aws organizations enable-aws-service-access \\
  --service-principal iam.amazonaws.com

ROOT_ACCESS_FEATURES="$(aws iam list-organizations-features \\
  --query 'EnabledFeatures' \\
  --output text)"

if ! printf '%s\\n' "$ROOT_ACCESS_FEATURES" | grep -qw RootCredentialsManagement; then
  aws iam enable-organizations-root-credentials-management
fi

if ! printf '%s\\n' "$ROOT_ACCESS_FEATURES" | grep -qw RootSessions; then
  aws iam enable-organizations-root-sessions
fi

aws iam list-organizations-features --output table`;

export const MFA_RECOVERY_PROVISION_FRAGMENT = `
cat >/tmp/tontian-mfa-recovery-policy.json <<'EOF_MFA_RECOVERY_POLICY'
{"Version":"2012-10-17","Statement":[{"Sid":"CentralizedRootAccess","Effect":"Allow","Action":["iam:ListOrganizationsFeatures","iam:EnableOrganizationsRootCredentialsManagement","iam:EnableOrganizationsRootSessions","organizations:DescribeOrganization","organizations:DescribeAccount","organizations:ListAWSServiceAccessForOrganization","organizations:EnableAWSServiceAccess","organizations:ListDelegatedAdministrators","sts:AssumeRoot"],"Resource":"*"}]}
EOF_MFA_RECOVERY_POLICY
aws iam put-role-policy --role-name TontianOrganizationAutomationRole --policy-name TontianMfaRecoveryPolicy --policy-document file:///tmp/tontian-mfa-recovery-policy.json
${CENTRALIZED_ROOT_ACCESS_SETUP_COMMAND}
`;
