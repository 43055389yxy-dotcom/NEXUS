# NEXUS AWS Access

AWS 多账号统一访问中心。账号记录由 DynamoDB 保存，控制台临时会话由 Lambda Broker 和 STS 签发。

客户账号限制按成员账号 ID 直接挂载 `NEXUS-Restricted-Guardrails` SCP，不依赖 OU 名称或成员账号位置。管理员可以在 NEXUS 搜索客户账号并单独添加或取消 5 项限制，客户清单、限制状态和持久豁免保存在 DynamoDB。每日任务会补齐新增客户账号，但不会恢复已由管理员取消的账号。

CloudSweep 仍可在管理员确认后，将指定子账号移到 Root、解除直接挂载的限制 SCP，并写入相同的持久豁免。Root 级共享 SCP 不会被自动修改。

## Docker

```bash
cp .env.example .env.production
docker compose -f compose.production.yml up -d --build
```

运行环境必须提供：

- `AWS_CONSOLE_BROKER_URL`
- `AWS_CONSOLE_BROKER_TOKEN`

生产入口应放在受信任的反向代理鉴权之后。当前部署使用 Caddy `forward_auth`，容器不映射宿主机端口。

## Jenkins

流水线拉取仓库后执行：

```bash
docker compose -f compose.production.yml up -d --build
```

`.env.production` 由 Jenkins Credentials 或服务器安全文件提供，不应提交到 Git。

Jenkins 节点还需要 `aws` 和 `zip`，以发布 Broker Lambda：

```bash
./infra/deploy-lambda.sh
```
