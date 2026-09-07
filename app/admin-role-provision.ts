export const ADMIN_ROLE_TRUST_FRAGMENT = `
cat >/tmp/tontian-admin-trust.json <<EOF_ADMIN
{"Version":"2012-10-17","Statement":[{"Sid":"AllowOperationsAccount","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::\${OPS_ACCOUNT_ID}:root"},"Action":["sts:AssumeRole","sts:TagSession","sts:SetSourceIdentity"]},{"Sid":"DenyApplicationRoles","Effect":"Deny","Principal":"*","Action":"sts:AssumeRole","Condition":{"ArnLike":{"aws:PrincipalArn":["arn:aws:iam::*:role/TontianConsoleBrokerRole","arn:aws:iam::*:role/TontianOperationsRole","arn:aws:iam::*:role/TontianOrganizationAutomationRole"]}}}]}
EOF_ADMIN
`;
