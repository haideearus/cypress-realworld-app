const { REPOSITORY } = require("./wake-contract.cjs");

const WEB = `https://github.com/${REPOSITORY}`;
const NUMBER = /^[1-9]\d*$/;

function link(kind, id, title) {
  return NUMBER.test(String(id)) ? `[${title}](${WEB}/${kind}/${id})` : null;
}

function nextAction(ticket, config) {
  if (ticket.merge?.status === "intent")
    return "Verify the recorded merge before another request is sent.";
  if (ticket.delayedRetry && !ticket.delayedRetry.parent && config.priorityRetry)
    return `Earliest retry ${ticket.delayedRetry.notBefore}, after new eligible work and subject to current proof and limits.`;
  if (ticket.dependency)
    return "Check Dependency maintenance for the hold and whether a fresh candidate is eligible.";
  if (ticket.ci?.passed === false)
    return "CI failed. Open the saved CI run to inspect the failed checks.";
  if (ticket.pr)
    return "Check the failed stage and whether saved CI and review evidence match the exact PR commit.";
  return "No automatic retry is scheduled. Open the run to inspect the failed stage.";
}

function queueSummary(state, config) {
  const blocked = Object.entries(state.tickets).filter(
    ([id, ticket]) => NUMBER.test(id) && ticket.status === "blocked"
  );
  if (!blocked.length) return "";

  const latestRuns = new Map();
  for (const grant of Object.values(state.grants)) {
    const latest = latestRuns.get(grant.ticket);
    if (!latest || grant.at > latest.at) latestRuns.set(grant.ticket, grant);
  }

  const rows = blocked
    .sort(([left], [right]) => Number(right) - Number(left))
    .slice(0, 12)
    .map(([id, ticket]) => {
      const latest = latestRuns.get(Number(id));
      const links = [
        ticket.dependency ? null : link("issues", id, `Issue #${id}`),
        link("pull", ticket.pr, `PR #${ticket.pr}`),
        link("actions/runs", latest?.runId, "last attempt"),
        link("actions/runs", ticket.ci?.runId, "saved CI"),
        link("pull", ticket.delayedRetry?.fix?.pr, "verified harness fix"),
      ].filter(Boolean);
      const attempts = `${ticket.coding || 0} coding / ${ticket.reviews || 0} review / ${ticket.retries || 0} retries`;
      return `| ${links.join(" · ") || `Ledger entry #${id}`} | ${attempts} | ${nextAction(ticket, config)} |`;
    });
  return [
    "",
    "### Blocked work",
    "",
    `Showing ${rows.length} of ${blocked.length} blocked ledger entries. This includes history. GitHub shows whether each issue is still open.`,
    "",
    "| Work and evidence | Attempts used | Next action |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

module.exports = { queueSummary };
