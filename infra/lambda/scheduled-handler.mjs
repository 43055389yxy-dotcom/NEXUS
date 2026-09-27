export function createScheduledHandler({ task, matches, run, checkBridge, requiredEnvironment = [] }) {
  if (!task || typeof matches !== "function" || typeof run !== "function") {
    throw new TypeError("Invalid scheduled handler configuration");
  }

  return async function handler(event = {}) {
    if (event?.healthcheck === true) {
      const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);
      return {
        ok: missingEnvironment.length === 0,
        task,
        missingEnvironment,
      };
    }

    if (event?.bridgeHealthcheck === true) {
      if (typeof checkBridge !== "function") throw new Error(`Bridge check is not configured for ${task}`);
      return { ok: true, task, bridge: await checkBridge() };
    }

    if (!matches(event)) {
      throw new Error(`Unexpected event for ${task}`);
    }

    const result = await run({ event });
    return { ok: true, task, result };
  };
}
