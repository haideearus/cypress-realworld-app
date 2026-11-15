const { UUID } = require("./monitor-proof.cjs");
const SHA = /^[a-f0-9]{40}$/;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const runId = (n) => typeof n === "string" && /^[1-9]\d{0,15}$/.test(n) && positive(Number(n));
const iso = (s) =>
  typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
function validateRetirement(r) {
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join(",") !==
      "approvalActor,at,ciRunId,deployRunId,grantId,head,mergeCommit,monitorRunId,phase,pr,probeMode,verifiedAt,version,workflowSha" ||
    r.version !== 1 ||
    !["intent", "complete"].includes(r.phase) ||
    !iso(r.at) ||
    !iso(r.verifiedAt) ||
    Date.parse(r.at) > Date.parse(r.verifiedAt) ||
    !positive(r.pr) ||
    !SHA.test(r.head) ||
    !SHA.test(r.mergeCommit) ||
    !UUID.test(r.grantId) ||
    !runId(r.deployRunId) ||
    !runId(r.ciRunId) ||
    !runId(r.monitorRunId) ||
    !SHA.test(r.workflowSha) ||
    r.approvalActor !== "haideearus" ||
    !["standard", "feed-contract"].includes(r.probeMode)
  )
    throw Error("Invalid monitor retirement proof");
  return r;
}
module.exports = { validateRetirement };
