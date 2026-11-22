const c = require("./discovery-contract.cjs");
const functional = require("./discovery-functional.cjs");
const { ROOT } = require("./github.cjs");
const { verifySweepSource } = require("./discovery-origin.cjs");
const { sourceBody } = require("./discovery-run.cjs");

function browserEvidenceSettled({ browserFollowUp, actualBatches = [] }) {
  return (
    (browserFollowUp === undefined || browserFollowUp === false) &&
    Array.isArray(actualBatches) &&
    actualBatches.every(
      (batch) =>
        batch && (batch.mode !== "cypress" || (batch.code === 0 && batch.networkIsolated === true))
    )
  );
}

function allFindingsAccountedFor(registry, grant, keys) {
  return keys.every((key) =>
    Object.values(registry.records).some((row) => {
      const source = row.candidate;
      const direct = source.key === key && source.source.grantId === grant;
      const duplicate = row.duplicates.some(
        (entry) =>
          entry.key === key &&
          entry.source.grantId === grant &&
          Number.isSafeInteger(entry.comment?.id)
      );
      return (
        (direct || duplicate) &&
        ["published", "observed-resolved", "repair-merged"].includes(row.status) &&
        row.publication?.confirmation &&
        Number.isSafeInteger(row.publication.issue) &&
        ["ready", "observed-resolved"].includes(row.intake?.outcome) &&
        c.HASH.test(row.intake.evidenceHash || "")
      );
    })
  );
}

function matchesAudit(issue, ticket, proof) {
  return (
    issue.number === ticket &&
    issue.user?.id === 41898282 &&
    issue.user?.login === "github-actions[bot]" &&
    !issue.pull_request &&
    issue.labels?.length === 0 &&
    issue.title === `Discovery sweep: ${proof.charter} (${proof.day})` &&
    issue.body === sourceBody(proof)
  );
}

async function recordDisposition(store, grantId, entry, status) {
  await store.update((state) => {
    const current = state.imports[grantId];
    if (c.digest(current) !== c.digest(entry)) throw Error("Sweep intake receipt changed");
    current.sweepClosure.status = status;
    return { state };
  });
}

async function closeCompletedSweeps({ api, ledger, store, discovery, controls, registry }) {
  const pending = Object.entries(registry.imports)
    .reverse()
    .filter(
      ([grant, entry]) =>
        entry.status === "complete" &&
        entry.sweepClosure?.status === "pending" &&
        allFindingsAccountedFor(registry, grant, entry.findings)
    )
    .slice(0, 4);

  const closed = [];
  for (const [grantId, entry] of pending) {
    const grant = controls.grants[grantId];
    const proof = grant && controls.tickets[grant.ticket]?.discovery;
    if (!proof || !functional.CHARTERS.includes(proof.charter) || entry.runId !== grant.runId) {
      await recordDisposition(store, grantId, entry, "held");
      continue;
    }
    const artifact = {
      id: entry.sweepClosure.artifactId,
      name: `discovery-evidence-${grantId}`,
      digest: entry.sweepClosure.artifactDigest,
    };
    let verified;
    try {
      verified = await verifySweepSource(api, { ...proof, grantId }, artifact, {
        ledger,
        discovery,
      });
    } catch (error) {
      if (error.status !== 404 && error.status !== 410) throw error;
    }
    if (!verified) {
      await recordDisposition(store, grantId, entry, "held");
      continue;
    }
    const endpoint = `${ROOT}/issues/${grant.ticket}`;
    let issue = await api.request("GET", endpoint);
    const latest = (await ledger.read()).state;
    if (latest.stop) break;
    if (matchesAudit(issue, grant.ticket, proof) && issue.state === "open") {
      let writeError;
      try {
        await api.request("PATCH", endpoint, { state: "closed", state_reason: "completed" });
      } catch (error) {
        writeError = error;
      }
      issue = await api.request("GET", endpoint);
      if (writeError && issue.state !== "closed") throw writeError;
    }
    if (
      !matchesAudit(issue, grant.ticket, proof) ||
      issue.state !== "closed" ||
      issue.state_reason !== "completed"
    ) {
      await recordDisposition(store, grantId, entry, "held");
      continue;
    }
    await recordDisposition(store, grantId, entry, "completed");
    closed.push(grant.ticket);
  }
  return closed;
}

module.exports = { browserEvidenceSettled, closeCompletedSweeps };
