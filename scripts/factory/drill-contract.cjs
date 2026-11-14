// Pure drill identity checks; this module must not depend on the ledger or GitHub.
const { UUID } = require("./monitor-proof.cjs");
const REPOSITORY = "haideearus/cypress-realworld-app";
const OWNER = "haideearus";
const SHA = /^[a-f0-9]{40}$/;
const DRILL_WORKFLOW_REF = `${REPOSITORY}/.github/workflows/factory-monitor-drill.yml@refs/heads/main`;
const DRILL_PATH = "backend/factory-drill/readiness.cjs";
const DRILL_TEST_PATH = "src/__tests__/factory-drill-readiness.test.ts";
function isDrillContext(context) {
  return Boolean(
    context &&
      context.repository === REPOSITORY &&
      context.actor === OWNER &&
      context.triggeringActor === OWNER &&
      context.ref === "refs/heads/main" &&
      context.event === "workflow_dispatch" &&
      context.workflowRef === DRILL_WORKFLOW_REF &&
      typeof context.workflowSha === "string" &&
      SHA.test(context.workflowSha) &&
      typeof context.runId === "string" &&
      /^[1-9]\d*$/.test(context.runId) &&
      context.runAttempt === 1
  );
}
function validateDrillProof(proof) {
  return Boolean(
    proof &&
      typeof proof === "object" &&
      !Array.isArray(proof) &&
      Object.keys(proof).sort().join(",") ===
        "incidentId,runAttempt,runId,seedSha,workflowRef,workflowSha" &&
      typeof proof.runId === "string" &&
      /^[1-9]\d*$/.test(proof.runId) &&
      proof.runAttempt === 1 &&
      proof.workflowRef === DRILL_WORKFLOW_REF &&
      typeof proof.workflowSha === "string" &&
      SHA.test(proof.workflowSha) &&
      typeof proof.seedSha === "string" &&
      SHA.test(proof.seedSha) &&
      typeof proof.incidentId === "string" &&
      UUID.test(proof.incidentId)
  );
}
module.exports = {
  DRILL_WORKFLOW_REF,
  DRILL_PATH,
  DRILL_TEST_PATH,
  isDrillContext,
  validateDrillProof,
};
