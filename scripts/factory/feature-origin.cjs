const { ROOT } = require("./github.cjs");
const c = require("./feature-contract.cjs");
const { storeFor } = require("./feature-publication.cjs");

async function verifyFeatureIssue(api, issue, { mode, proof, allowClosed = false, state } = {}) {
  if (!c.marked(issue) || issue.user?.id !== c.BOT.id) return null;
  const marker = /<!-- factory-feature:([a-f0-9]{64}):([0-4]) -->$/.exec(issue.body);
  if (!marker) return null;
  const key = marker[1];
  const index = Number(marker[2]);
  const registry = state || (await storeFor(api).read({ allowMissing: true })).state;
  const row = registry.records[key];
  if (
    !row ||
    row.stages[index]?.phase !== "ready" ||
    (mode && row.producer.mode !== mode) ||
    !c.issueMatches(issue, key, row, index, true, allowClosed)
  )
    return null;
  const actual = c.validateReceipt(c.receiptFor(key, row, index));
  return !proof || c.digest(actual) === c.digest(proof) ? actual : null;
}

async function readyFeature(api, ledger, mode, registry) {
  if (!["pilot", "live"].includes(mode)) return null;
  const state = registry ?? (await storeFor(api).read({ allowMissing: true })).state;
  const available = Object.entries(state.records).flatMap(([key, row]) =>
    row.producer.mode === mode
      ? row.stages
          .filter((entry) => entry?.phase === "ready" && !ledger.tickets[String(entry.issue)])
          .map((entry) => ({ key, issue: entry.issue }))
      : []
  );
  const candidates = [];
  for (const entry of available) {
    const issue = await api.request("GET", ROOT + "/issues/" + entry.issue);
    if (await verifyFeatureIssue(api, issue, { mode, state })) candidates.push(issue);
  }
  if (candidates.length > 1) throw Error("Multiple open weekly feature receipts; pickup held");
  return candidates[0] || null;
}
module.exports = { verifyFeatureIssue, readyFeature };
