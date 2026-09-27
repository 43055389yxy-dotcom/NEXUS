# NEXUS scheduled Lambda isolation

The API broker remains `TontianConsoleBroker`. Its four scheduled workloads are deployed separately:

| Workload | Lambda | EventBridge rule |
| --- | --- | --- |
| Support billing | `NexusSupportBillingScheduled` | `nexus-support-billing-daily-check` |
| APN monitor | `NexusApnMonitorScheduled` | `nexus-apn-status-monitor-daily` |
| Credit monitor | `NexusCreditMonitorScheduled` | `nexus-credit-monitor-daily` |
| OU automation | `NexusOuAutomationScheduled` | `nexus-daily-ou-reconciliation` |

Each Lambda has a dedicated least-privilege execution role. Cross-account calls use the existing `TontianConsoleBrokerRole` as a short-lived bridge so member accounts do not need new trust policies.

Run from the repository root with the intended AWS profile already selected:

```bash
# Create or update roles/functions and perform side-effect-free health checks.
AWS_REGION=us-east-1 ./infra/deploy-scheduled-lambdas.sh deploy

# Deploy, health-check, then move the four existing EventBridge targets.
AWS_REGION=us-east-1 ./infra/deploy-scheduled-lambdas.sh cutover

# Point all four rules back to TontianConsoleBroker without deleting anything.
AWS_REGION=us-east-1 ./infra/deploy-scheduled-lambdas.sh rollback

# Show the current target of each rule.
AWS_REGION=us-east-1 ./infra/deploy-scheduled-lambdas.sh status
```

The cutover keeps the original broker code, permissions, and Lambda invocation permissions in place for rollback. Do not delete them until the isolated functions have completed multiple production schedules successfully.
