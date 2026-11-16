// Pure receipt validation: safe to import from policy without a GitHub dependency cycle.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function validateMonitorProof(proof) {
  const contract = proof?.version === 2;
  return Boolean(
    proof &&
      typeof proof === "object" &&
      !Array.isArray(proof) &&
      Object.keys(proof).sort().join(",") ===
        (contract
          ? "criteriaHash,incidentId,issue,probeMode,runAttempt,runId,version,workflowSha"
          : "criteriaHash,incidentId,issue,runAttempt,runId,version,workflowSha") &&
      (contract ? proof.probeMode === "feed-contract" : proof.version === 1) &&
      typeof proof.incidentId === "string" &&
      UUID.test(proof.incidentId) &&
      Number.isSafeInteger(proof.issue) &&
      proof.issue > 0 &&
      typeof proof.criteriaHash === "string" &&
      /^[a-f0-9]{64}$/.test(proof.criteriaHash) &&
      typeof proof.runId === "string" &&
      /^[1-9]\d*$/.test(proof.runId) &&
      proof.runAttempt === 1 &&
      typeof proof.workflowSha === "string" &&
      /^[a-f0-9]{40}$/.test(proof.workflowSha)
  );
}
function proofFromIncident(incident) {
  return {
    version: incident.probeMode ? 2 : 1,
    ...(incident.probeMode ? { probeMode: incident.probeMode } : {}),
    incidentId: incident.id,
    issue: incident.issue,
    criteriaHash: incident.criteriaHash,
    ...incident.source,
  };
}
module.exports = { UUID, validateMonitorProof, proofFromIncident };
