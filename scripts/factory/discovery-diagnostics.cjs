const STAGES = new Set([
  "discovery",
  "recovery",
  "image-build",
  "replay-prepare",
  "proposal-replay",
  "oracle-replay",
  "finalization",
]);
const stages = new WeakMap();
const safeStage = (stage) => (STAGES.has(stage) ? stage : "unknown");
const object = (value) =>
  value !== null && (typeof value === "object" || typeof value === "function");

function field(error, key) {
  try {
    return object(error) ? error[key] : undefined;
  } catch {
    return undefined;
  }
}

function diagnostic(stage, error) {
  const status = field(error, "status");
  const validStatus = Number.isInteger(status) && status >= 100 && status <= 599;
  return {
    stage: (object(error) && stages.get(error)) || safeStage(stage),
    code: "factory-operation-failed",
    category:
      field(error, "rateLimited") === true ? "rate-limit" : validStatus ? "http" : "unknown",
    ...(validStatus ? { status } : {}),
  };
}

async function withStage(stage, fn) {
  try {
    return await fn();
  } catch (error) {
    // Out-of-band metadata works for frozen errors and never copies attacker-controlled fields.
    if (object(error) && (!stages.has(error) || stages.get(error) === "unknown"))
      stages.set(error, safeStage(stage));
    throw error;
  }
}

module.exports = { diagnostic, withStage };
