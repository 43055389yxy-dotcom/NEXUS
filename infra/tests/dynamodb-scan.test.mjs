import assert from "node:assert/strict";
import test from "node:test";
import { scanAllItems } from "../lambda/dynamodb-scan.mjs";

test("scanAllItems returns every DynamoDB scan page", async () => {
  const client = {};
  const input = { TableName: "Accounts" };
  async function* paginate(config, receivedInput) {
    assert.equal(config.client, client);
    assert.equal(receivedInput, input);
    yield { Items: [{ accountId: { S: "first" } }] };
    yield { Items: [{ accountId: { S: "second" } }] };
  };

  const items = await scanAllItems(client, input, paginate);

  assert.deepEqual(items.map((item) => item.accountId.S), ["first", "second"]);
});
