export const BILLING_TRANSFER_PROVISION_FRAGMENT = `
cat >/tmp/tontian-billing-transfer-policy.json <<EOF_BILLING_TRANSFER
{"Version":"2012-10-17","Statement":[{"Sid":"ManageBillingTransfers","Effect":"Allow","Action":["organizations:InviteOrganizationToTransferResponsibility","organizations:DescribeResponsibilityTransfer","billingconductor:CreateBillingGroup","billingconductor:ListPricingPlans","billingconductor:GetBillingTransferPreference","billingconductor:UpdateBillingTransferPreference"],"Resource":"*"},{"Sid":"CreateBillingConductorServiceLinkedRole","Effect":"Allow","Action":"iam:CreateServiceLinkedRole","Resource":"arn:aws:iam::\${CURRENT_ACCOUNT_ID}:role/aws-service-role/billingconductor.amazonaws.com/AWSServiceRoleForBillingConductor","Condition":{"StringEquals":{"iam:AWSServiceName":"billingconductor.amazonaws.com"}}}]}
EOF_BILLING_TRANSFER
aws iam put-role-policy --role-name TontianOperationsRole --policy-name TontianBillingTransferManagement --policy-document file:///tmp/tontian-billing-transfer-policy.json
`;
