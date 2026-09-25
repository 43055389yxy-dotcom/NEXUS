# NEXUS AWS Access

AWS 多账号统一访问中心。账号记录由 DynamoDB 保存，控制台临时会话由 Lambda Broker 和 STS 签发。

OU 自动化还向 CloudSweep 提供管理员确认的 SCP 整改接口：只在子账号扫描遇到明确的 SCP 拒绝后，定位所属代付 Organization，将该子账号移到 Root，解除直接挂载的非 `FullAWSAccess` SCP，并写入持久豁免以防自动归位。Root 级共享 SCP 不会被自动修改。

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
