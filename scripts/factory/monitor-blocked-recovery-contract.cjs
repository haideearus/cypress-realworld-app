const { SHA } = require("./policy.cjs");
const { UUID } = require("./monitor-proof.cjs");

const MIN_GAP = 5 * 60 * 1000;
const MAX_GAP = 24 * 60 * 60 * 1000;
const MAX_LATEST_AGE = 90 * 60 * 1000;
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === keys;
const runId = (id) =>
  typeof id === "string" && /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id));
const iso = (at) =>
  typeof at === "string" && Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at;
const sameRepair = (a, b) =>
  a && b && ["grantId", "head", "runId", "runAttempt"].every((key) => a[key] === b[key]);

function followsRecovery(before, after) {
  const elapsed = Date.parse(after.at) - Date.parse(before.at);
  return (
    before.runId !== after.runId &&
    before.release === after.release &&
    elapsed >= MIN_GAP &&
    elapsed <= MAX_GAP
  );
}

function validateBlockedRecovery(receipt) {
  if (!exact(receipt, "observations,repair")) throw Error("Invalid blocked monitor recovery");
  const { repair, observations } = receipt;
  if (
    !exact(repair, "grantId,head,runAttempt,runId") ||
    !UUID.test(repair.grantId || "") ||
    !SHA.test(repair.head || "") ||
    !runId(repair.runId) ||
    !Number.isSafeInteger(repair.runAttempt) ||
    repair.runAttempt < 1 ||
    !Array.isArray(observations) ||
    ![1, 2].includes(observations.length) ||
    observations.some(
      (row) =>
        !exact(row, "at,release,runId,workflowSha") ||
        !iso(row.at) ||
        !runId(row.runId) ||
        row.runId === repair.runId ||
        !SHA.test(row.release || "") ||
        !SHA.test(row.workflowSha || "")
    ) ||
    (observations.length === 2 && !followsRecovery(observations[0], observations[1]))
  )
    throw Error("Invalid blocked monitor recovery evidence");
  return receipt;
}

module.exports = { MAX_LATEST_AGE, followsRecovery, sameRepair, validateBlockedRecovery };
