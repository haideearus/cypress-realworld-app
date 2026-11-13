const { secretLike } = require("../artifacts.cjs");
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function validateSource(source) {
  if (
    typeof source !== "string" ||
    !source.trim() ||
    Buffer.byteLength(source) > 32768 ||
    /[\0\uFFFD]/.test(source) ||
    Buffer.from(source, "utf8").toString("utf8") !== source ||
    secretLike(source)
  )
    throw new Error("Invalid bounded fixture source");
  return source;
}

function validateObservation(value, release) {
  if (
    !SHA.test(release || "") ||
    !exactKeys(value, [
      "healthy",
      "checks",
      "attempts",
      ...(value?.release !== undefined ? ["release"] : []),
    ]) ||
    !exactKeys(value.checks, ["health", "readiness", "frontend", "regression"]) ||
    typeof value.healthy !== "boolean" ||
    value.attempts !== 1 ||
    Object.values(value.checks).some((check) => !["ok", "failed"].includes(check)) ||
    value.healthy !== Object.values(value.checks).every((check) => check === "ok") ||
    (value.checks.health === "ok" ? value.release !== release : value.release !== undefined)
  )
    throw new Error("Invalid sandbox observation");
  return structuredClone(value);
}

function assertBaseline(observation) {
  if (
    observation.healthy !== false ||
    observation.checks.health !== "ok" ||
    observation.checks.frontend !== "ok" ||
    observation.checks.readiness !== "failed" ||
    observation.checks.regression !== "failed"
  )
    throw new Error("Drill baseline does not exhibit the seeded readiness failure");
}

module.exports = { SHA, UUID, exactKeys, validateSource, validateObservation, assertBaseline };
