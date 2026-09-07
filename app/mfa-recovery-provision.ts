export const MFA_RECOVERY_PROVISION_FRAGMENT = `
cat >/tmp/tontian-mfa-recovery-policy.json <<'EOF_MFA_RECOVERY_POLICY'
{"Version":"2012-10-17","Statement":[{"Sid":"CentralizedRootAccess","Effect":"Allow","Action":["iam:ListOrganizationsFeatures","iam:EnableOrganizationsRootCredentialsManagement","iam:EnableOrganizationsRootSessions","organizations:DescribeOrganization","organizations:DescribeAccount","organizations:ListAWSServiceAccessForOrganization","organizations:EnableAWSServiceAccess","organizations:ListDelegatedAdministrators","sts:AssumeRoot"],"Resource":"*"}]}
EOF_MFA_RECOVERY_POLICY
aws iam put-role-policy --role-name TontianOrganizationAutomationRole --policy-name TontianMfaRecoveryPolicy --policy-document file:///tmp/tontian-mfa-recovery-policy.json
`;
