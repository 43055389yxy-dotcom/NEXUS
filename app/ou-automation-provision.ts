export const OU_AUTOMATION_PROVISION_FRAGMENT = `
cat >/tmp/tontian-ou-automation-trust.json <<EOF_AUTOMATION_TRUST
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::\${OPS_ACCOUNT_ID}:role/TontianConsoleBrokerRole"},"Action":"sts:AssumeRole"}]}
EOF_AUTOMATION_TRUST

if aws iam get-role --role-name TontianOrganizationAutomationRole >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name TontianOrganizationAutomationRole --policy-document file:///tmp/tontian-ou-automation-trust.json
else
  aws iam create-role --role-name TontianOrganizationAutomationRole --max-session-duration 3600 --assume-role-policy-document file:///tmp/tontian-ou-automation-trust.json
fi

cat >/tmp/tontian-ou-automation-policy.json <<'EOF_AUTOMATION_POLICY'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["organizations:DescribeOrganization","organizations:ListRoots","organizations:ListOrganizationalUnitsForParent","organizations:CreateOrganizationalUnit","organizations:EnablePolicyType","organizations:ListPolicies","organizations:DescribePolicy","organizations:CreatePolicy","organizations:UpdatePolicy","organizations:ListPoliciesForTarget","organizations:AttachPolicy","organizations:ListAccounts","organizations:ListParents","organizations:MoveAccount"],"Resource":"*"}]}
EOF_AUTOMATION_POLICY
aws iam put-role-policy --role-name TontianOrganizationAutomationRole --policy-name TontianOrganizationAutomationPolicy --policy-document file:///tmp/tontian-ou-automation-policy.json
`;
