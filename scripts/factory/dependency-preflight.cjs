const { setTimeout: sleep } = require("node:timers/promises");
const d = require("./dependency-contract.cjs");
const policy = require("./policy.cjs");
const { collectEvidence } = require("./dependency-evidence.cjs");
const { PublicEvidenceError } = require("./dependency-evidence-http.cjs");

function verifyPacket(t, packet, now = new Date()) {
  const attempt = d.validateTicket(t);
  const receipt = attempt.evidence?.at(-1);
  const age = now.getTime() - Date.parse(packet?.checkedAt);
  if (
    receipt?.status !== "ready" ||
    packet?.version !== 2 ||
    packet.base !== attempt.base ||
    packet.head !== t.head ||
    packet.ciEvidence?.status !== "verified" ||
    packet.ciEvidence.head !== t.head ||
    packet.ciEvidence.runId !== t.ci?.runId ||
    !Number.isSafeInteger(packet.ciEvidence.runAttempt) ||
    packet.ciEvidence.runAttempt < 1 ||
    t.ci?.passed !== true ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 15 * 60000 ||
    d.digest(packet) !== receipt.digest
  )
    throw new Error("Missing, stale or mismatched dependency evidence packet");
  return packet;
}

function evidenceTransport(token, transport = fetch) {
  const ciRoot = `https://api.github.com/repos/${d.REPOSITORY}/actions/`;
  return (url, options) =>
    transport(
      url,
      url.startsWith(ciRoot) && options.method === "GET" && token
        ? { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } }
        : options
    );
}

async function prepare(
  coordinator,
  number,
  source,
  { transport = fetch, clock = () => new Date(), wait = sleep } = {}
) {
  if (!coordinator.config.enabled || !coordinator.config.automatic)
    throw new Error("Dependency factory disabled");

  async function record(t, index, update) {
    await coordinator.ledger.update((state) => {
      policy.assertNotStopped(state);
      coordinator.controller.activeRun(state, number);
      const current = state.tickets[String(number)];
      const attempt = d.matches(current, coordinator.context, coordinator.config);
      if (current.head !== t.head || current.ci?.runId !== t.ci.runId)
        throw new Error("Dependency evidence identity changed");
      const records = (attempt.evidence ??= []);
      if (update.status === "started") {
        if (records.length !== index)
          throw new Error("Dependency evidence attempt already recorded");
        records.push(update);
      } else {
        if (records.length !== index + 1 || records[index].status !== "started")
          throw new Error("Dependency evidence attempt is no longer active");
        Object.assign(records[index], update);
      }
      return { state: policy.validateState(state) };
    });
  }

  for (let index = 0; index < 2; index++) {
    const t = await coordinator.ticket(number);
    if (t.analysis?.head !== t.head || t.ci?.head !== t.head || t.ci.passed !== true)
      throw new Error("Dependency analysis and CI required before evidence");
    await record(t, index, { at: clock().toISOString(), status: "started" });
    const input = await source(t);
    let packet;
    let reason;
    try {
      packet = await collectEvidence(input, { transport, clock });
    } catch (error) {
      reason = error instanceof PublicEvidenceError ? error.code : "invalid_public_evidence";
    }
    if (packet || reason === "public_service_unavailable") {
      try {
        await coordinator.pr(number, { expected: t });
      } catch (error) {
        if (
          !/^(Dependency head changed|Dependency PR requires a current-main rebase)$/.test(
            error.message
          )
        )
          throw error;
        reason = "candidate_changed";
        packet = undefined;
      }
    }
    const finishedAt = clock().toISOString();
    if (packet) {
      await record(t, index, { status: "ready", digest: d.digest(packet), finishedAt });
      return { ready: true, packet, reason: "Exact-head public dependency evidence verified" };
    }
    const retry = index === 0 && reason === "public_service_unavailable";
    await record(t, index, { status: retry ? "temporary" : "held", reason, finishedAt });
    if (!retry) return { ready: false, reason: d.EVIDENCE_REASONS[reason] };
    await wait(d.EVIDENCE_DELAY_MS);
  }
}
module.exports = { prepare, verifyPacket, evidenceTransport };
