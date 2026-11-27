// Even cancellations before a review reservation must eventually stop dispatching.
const MAX_CONTINUATIONS = 3;
const interrupted = (value) => ["cancelled", "timed_out"].includes(value);

function withinLimit(receipt, runId) {
  const past = receipt.interruptedParents ?? [];
  return (
    past.length < MAX_CONTINUATIONS &&
    !past.some((p) => p.runId === runId) &&
    (!receipt.parent || past.at(-1)?.runId === receipt.parent.runId)
  );
}

function validHistory(receipt, validOwner, passingCiReceipt, grants) {
  const past = receipt.interruptedParents;
  if (
    !Array.isArray(past) ||
    !receipt.parent ||
    past.length === 0 ||
    past.length > MAX_CONTINUATIONS
  )
    return false;
  if (new Set(past.map((p) => p?.runId)).size !== past.length) return false;
  if (past.length === MAX_CONTINUATIONS && past.at(-1)?.runId !== receipt.parent.runId)
    return false;
  return past.every((row, i) => {
    if (!row || typeof row !== "object") return false;
    const { ci, staleBase, ...owner } = row;
    const matchesCurrent = owner.runId === receipt.parent.runId;
    return (
      validOwner(owner) &&
      (staleBase === undefined || staleBase === true) &&
      (ci === null || (passingCiReceipt(ci) && ci.head === owner.head)) &&
      (!matchesCurrent ||
        (i === past.length - 1 &&
          owner.head === receipt.parent.head &&
          owner.workflowSha === receipt.parent.workflowSha)) &&
      grants
        .filter((g) => g.phase === "review" && g.runId === owner.runId)
        .every(
          (g) =>
            g.status === "finished" &&
            (g.outcome === "blocked" || (staleBase && g.outcome === "reviewed" && ci)) &&
            g.head === owner.head
        )
    );
  });
}

// Check the public results of every cycle stage. A completed review or failed
// product check is substantive evidence and cannot authorize buying another review.
function interruptedJobs(jobs, { publishedHere, ci, reviewReserved }) {
  const incomplete = ["skipped", "cancelled", "timed_out"];
  const result = (name, allowed) => jobMatches(jobs, name, allowed);
  return (
    result("coding", [publishedHere ? "success" : "skipped"]) &&
    result("publish", [publishedHere ? "success" : "skipped"]) &&
    result("ci", ci ? ["success", ...incomplete] : incomplete) &&
    result("reserve_review", reviewReserved ? ["success", "cancelled", "timed_out"] : incomplete) &&
    result("review", incomplete) &&
    result("assess", incomplete) &&
    (!reviewReserved || Boolean(ci))
  );
}

function jobMatches(jobs, name, allowed) {
  const matches = jobs.filter(
    (j) => j.name === `cycle1 / ${name}` || j.name === `cycle1 / ${name} / agent`
  );
  return (
    matches.length === 1 &&
    matches[0].status === "completed" &&
    allowed.includes(matches[0].conclusion)
  );
}

function staleJobs(jobs, grant, ci) {
  const result = (name, allowed) => jobMatches(jobs, name, allowed);
  if (
    !result("coding", ["skipped"]) ||
    !result("publish", ["skipped"]) ||
    !result("assess", ["success"])
  )
    return false;
  if (grant?.outcome === "reviewed")
    return (
      Boolean(ci) &&
      result("ci", ["success"]) &&
      result("reserve_review", ["success"]) &&
      result("review", ["success"])
    );
  return (
    result("ci", ci ? ["success", "failure"] : ["skipped", "failure"]) &&
    result("reserve_review", grant ? ["success"] : ["skipped", "failure"]) &&
    result("review", ["skipped", "cancelled", "timed_out"]) &&
    (!grant || Boolean(ci))
  );
}

module.exports = {
  MAX_CONTINUATIONS,
  interrupted,
  withinLimit,
  validHistory,
  interruptedJobs,
  staleJobs,
};
