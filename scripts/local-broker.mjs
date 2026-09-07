import http from "node:http";

process.env.AWS_PROFILE ||= "nexus-local-broker";
process.env.AWS_REGION ||= "us-east-1";
process.env.AWS_DEFAULT_REGION ||= "us-east-1";
process.env.AWS_SDK_LOAD_CONFIG ||= "1";
process.env.ACCOUNTS_TABLE ||= "TontianAwsAccessAccounts";
process.env.GROUPS_TABLE ||= "TontianAwsAccessGroups";
process.env.OU_HISTORY_TABLE ||= "TontianOuAutomationHistory";
process.env.OPS_ACCOUNT_ID ||= "590184009438";
process.env.INTERNAL_API_KEY = "nexus-local-dev";

const { handler } = await import("../infra/lambda/index.mjs");
const port = Number(process.env.NEXUS_LOCAL_BROKER_PORT || 8787);

const server = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    const result = await handler({
      rawPath: url.pathname,
      path: url.pathname,
      requestContext: { http: { method: request.method || "GET" } },
      headers: request.headers,
      body,
      isBase64Encoded: false,
    });
    response.writeHead(result.statusCode || 200, result.headers || { "content-type": "application/json" });
    response.end(result.body || "{}");
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: error?.message || "Local broker failed" }));
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Local AWS broker: http://127.0.0.1:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
