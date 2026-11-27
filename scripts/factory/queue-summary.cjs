const { REPOSITORY } = require("./wake-contract.cjs");
const mergeRetry = require("./dependency-merge-retry.cjs");
const { effectiveLimit } = require("./ticket-ai-budget.cjs");

const WEB = `https://github.com/${REPOSITORY}`;
const NUMBER = /^[1-9]\d*$/;

function link(kind, id, title) {
  return NUMBER.test(String(id)) ? `[${title}](${WEB}/${kind}/${id})` : null;
}

function nextAction(ticket, config) {
  if (ticket.merge?.status === "intent")
    return "Verify the recorded merge before another request is sent.";
  const retry = mergeRetry.current(ticket);
  if (retry) {
    const reason = `${retry.failure.stage}: ${retry.failure.reason}.`;
    if (retry.phase === "queued") return `${reason} Merge-only retry at or after ${retry.retryAt}.`;
    if (retry.phase === "retrying" && mergeRetry.blocksQueue(ticket))
      return `${reason} Merge-only retry claimed.`;
    return `${reason} Merge held with approval retained. Other work can proceed.`;
  }
  if (ticket.delayedRetry && !ticket.delayedRetry.parent && config.priorityRetry)
    return `Earliest retry ${ticket.delayedRetry.notBefore}, after new eligible work and subject to current proof and limits.`;
  if (ticket.dependency)
    return "Check Dependency maintenance for the hold and whether a fresh candidate is eligible.";
  if (ticket.publishedRecovery) {
    const { STALE_REASON, INTERRUPTED_REASON } = require("./published-review-recovery.cjs");
    if (ticket.publishedRecovery.interruptedHead) {
      if (!require("./ticket-ai-budget.cjs").canReserve(ticket, "review", config))
        return "Review or lifetime session allowance exhausted. The interrupted repair stays parked.";
      if (
        (ticket.publishedRecovery.interruptedParents?.length ?? 0) >=
        require("./interrupted-publication.cjs").MAX_CONTINUATIONS
      )
        return "Interrupted repair continuation limit reached. Other work can use the slot.";
      return ticket.feedback === INTERRUPTED_REASON
        ? "Recheck the interrupted publication before admitting fresh work."
        : "Inspect the last published repair stage. It has no confirmed resumable interruption.";
    }
    if (!ticket.publishedRecovery.previousParent && ticket.feedback === STALE_REASON)
      return "Waiting for tested main and a verified branch refresh before new CI and review.";
    if (
      !ticket.publishedRecovery.previousParent &&
      ticket.feedback === INTERRUPTED_REASON &&
      !ticket.reviews
    )
      return "Eligible to resume CI and review once after other ready work.";
  }
  if (ticket.ci?.passed === false)
    return "CI failed. Open the saved CI run to inspect the failed checks.";
  if (ticket.pr)
    return "Check the failed stage and whether saved CI and review evidence match the exact PR commit.";
  return "No automatic retry is scheduled. Open the run to inspect the failed stage.";
}

function queueSummary(state, config) {
  const blocked = Object.entries(state.tickets).filter(
    ([id, ticket]) =>
      NUMBER.test(id) &&
      (ticket.status === "blocked" ||
        (mergeRetry.current(ticket) && !["closed", "merged"].includes(ticket.merge?.status)))
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
      const retry = mergeRetry.current(ticket);
      const links = [
        ticket.dependency ? null : link("issues", id, `Issue #${id}`),
        link("pull", ticket.pr, `PR #${ticket.pr}`),
        link("actions/runs", latest?.runId, "last attempt"),
        retry && link("actions/runs", retry.run?.runId ?? retry.sourceRun, "merge attempt"),
        link("actions/runs", ticket.ci?.runId, "saved CI"),
        ticket.publishedRecovery?.sourceCi?.runId !== ticket.ci?.runId &&
          link("actions/runs", ticket.publishedRecovery?.sourceCi?.runId, "original CI"),
        link("pull", ticket.delayedRetry?.fix?.pr, "verified harness fix"),
      ].filter(Boolean);
      const attempts = `${ticket.coding || 0} coding / ${ticket.reviews || 0} review / ${ticket.retries || 0} retries`;
      const budget = ticket.automatic
        ? ` · ${ticket.coding + ticket.reviews} of ${effectiveLimit(ticket, config)} AI sessions reserved`
        : "";
      return `| ${links.join(" · ") || `Ledger entry #${id}`} | ${attempts}${budget} | ${nextAction(ticket, config)} |`;
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
