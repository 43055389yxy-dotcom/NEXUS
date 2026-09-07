export const SUPPORT_BILLING_PROVISION_FRAGMENT = `
cat >/tmp/tontian-support-billing-policy.json <<'EOF_SUPPORT_BILLING'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["billing:ListBillingViews","ce:GetDimensionValues","ce:GetCostAndUsage","organizations:ListAccounts","billingconductor:ListBillingGroups","billingconductor:ListAccountAssociations","billingconductor:ListCustomLineItems","billingconductor:ListCustomLineItemVersions","billingconductor:CreateCustomLineItem","billingconductor:UpdateCustomLineItem","billingconductor:DeleteCustomLineItem"],"Resource":"*"}]}
EOF_SUPPORT_BILLING
aws iam put-role-policy --role-name TontianOrganizationAutomationRole --policy-name TontianSupportBillingPolicy --policy-document file:///tmp/tontian-support-billing-policy.json
`;
