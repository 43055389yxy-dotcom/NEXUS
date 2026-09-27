import assert from "node:assert/strict";
import test from "node:test";
import { createScheduledHandler } from "../lambda/scheduled-handler.mjs";

test("healthcheck validates required environment without running the task", async () => {
  const original = process.env.TEST_REQUIRED_VALUE;
  delete process.env.TEST_REQUIRED_VALUE;
  let calls = 0;
  const handler = createScheduledHandler({
    task: "example",
    matches: () => true,
    run: async () => { calls += 1; },
    requiredEnvironment: ["TEST_REQUIRED_VALUE"],
  });

  assert.deepEqual(await handler({ healthcheck: true }), {
    ok: false,
    task: "example",
    missingEnvironment: ["TEST_REQUIRED_VALUE"],
  });
  assert.equal(calls, 0);

  if (original === undefined) delete process.env.TEST_REQUIRED_VALUE;
  else process.env.TEST_REQUIRED_VALUE = original;
});

test("unexpected events are rejected before the task runs", async () => {
  let calls = 0;
  const handler = createScheduledHandler({
    task: "example",
    matches: (event) => event?.task === "example",
    run: async () => { calls += 1; },
  });

  await assert.rejects(() => handler({ task: "other" }), /Unexpected event/);
  assert.equal(calls, 0);
});

test("matching events run once and return a task envelope", async () => {
  const handler = createScheduledHandler({
    task: "example",
    matches: (event) => event?.task === "example",
    run: async ({ event }) => ({ value: event.value }),
  });

  assert.deepEqual(await handler({ task: "example", value: 7 }), {
    ok: true,
    task: "example",
    result: { value: 7 },
  });
});

test("bridge healthcheck runs without executing the scheduled task", async () => {
  let calls = 0;
  const handler = createScheduledHandler({
    task: "example",
    matches: () => true,
    run: async () => { calls += 1; },
    checkBridge: async () => ({ mode: "bridge", account: "123456789012", role: "ExampleRole" }),
  });

  assert.deepEqual(await handler({ bridgeHealthcheck: true }), {
    ok: true,
    task: "example",
    bridge: { mode: "bridge", account: "123456789012", role: "ExampleRole" },
  });
  assert.equal(calls, 0);
});
