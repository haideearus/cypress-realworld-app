const ID = "issue-11-once-2026-11-13";
const DECISION = "https://github.com/haideearus/cypress-realworld-app/issues/18";
const CRITERIA = "d295d714446efad9eaa6b3bd3c0c25706756dcc2d26160a191f0253438279387";
const OLD_HEAD = "4f0eb6eca04cd603a5401439d0fdcd83d8c2c4d5";
const PRIOR = [
  ["503b7bc1-d82f-4bd2-84e8-fae30886f23a", "43203237182"],
  ["2b3030da-263c-432e-9069-3f38d0778248", "43391969547"],
];
function refuse() {
  throw new Error("Invalid or exhausted issue 11 recovery");
}
function priorFailures(state) {
  for (const [id, runId] of PRIOR) {
    const g = state.grants[id];
    if (
      !g ||
      g.id !== id ||
      g.ticket !== 11 ||
      g.phase !== "code" ||
      g.runId !== runId ||
      g.runAttempt !== 1 ||
      g.slot !== "cycle1" ||
      g.head !== OLD_HEAD ||
      g.status !== "finished" ||
      g.outcome !== "blocked" ||
      g.recovery !== undefined
    )
      refuse();
  }
}
function matchesTicket(t) {
  return t && t.origin === "factory" && t.criteriaHash === CRITERIA;
}
function validateState(state) {
  const marked = Object.entries(state.tickets).filter(([, t]) => t?.recovery !== undefined);
  const tagged = Object.values(state.grants).filter((g) => g?.recovery !== undefined);
  if (!marked.length && !tagged.length) return new Set();
  if (marked.length !== 1 || marked[0][0] !== "11" || tagged.length !== 1) refuse();
  const t = marked[0][1],
    r = t.recovery,
    g = tagged[0];
  if (
    !matchesTicket(t) ||
    t.coding !== 3 ||
    t.retries !== 1 ||
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join(",") !== "decision,grant,id" ||
    r.id !== ID ||
    r.decision !== DECISION ||
    r.grant !== g.id ||
    g.recovery !== ID ||
    g.ticket !== 11 ||
    g.phase !== "code" ||
    g.slot !== "cycle1" ||
    PRIOR.some(([id]) => id === g.id) ||
    state.grants[g.id] !== g
  )
    refuse();
  priorFailures(state);
  return new Set(["11"]);
}
function assertEligible(state, request, config) {
  const t = state.tickets["11"];
  if (
    request.recovery !== ID ||
    request.ticket !== 11 ||
    request.phase !== "code" ||
    request.slot !== "cycle1" ||
    request.origin !== undefined ||
    !matchesTicket(t) ||
    t.recovery !== undefined ||
    t.coding !== 2 ||
    t.retries !== 1 ||
    t.reviews !== 0 ||
    t.status !== "blocked" ||
    t.pr ||
    t.approval ||
    state.active ||
    config.coding !== 2 ||
    config.retries !== 1 ||
    config.reviews !== 2 ||
    config.daily !== 5 ||
    Object.values(state.grants).some((g) => g.status === "reserved") ||
    Object.values(state.grants).filter((g) => g.ticket === 11 && g.phase === "code").length !== 2
  )
    refuse();
  priorFailures(state);
}
function record(state, grant) {
  grant.recovery = ID;
  state.tickets["11"].recovery = { id: ID, grant: grant.id, decision: DECISION };
}
function allowance(state, ticket, config) {
  return state.tickets[String(ticket)]?.recovery &&
    config.coding === 2 &&
    config.retries === 1 &&
    config.reviews === 2 &&
    config.daily === 5
    ? 1
    : 0;
}
module.exports = { ID, validateState, assertEligible, record, allowance };
