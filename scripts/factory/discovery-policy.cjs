const { randomUUID } = require("node:crypto");
const c = require("./discovery-contract.cjs");
const active = require("./active-tickets.cjs");
function validateTicket(t, grants) {
  const d = c.validateProof(t.discovery);
  const g = grants[0];
  if (
    t.coding !== 0 ||
    t.reviews !== 0 ||
    t.retries !== 0 ||
    t.pr !== null ||
    t.approval !== null ||
    t.head !== d.head ||
    grants.length !== 1 ||
    !g ||
    g.phase !== "discover" ||
    g.slot !== "discovery" ||
    g.head !== d.head ||
    g.runId !== d.runId ||
    g.runAttempt !== 1 ||
    !["discovering", "discovery_complete", "blocked"].includes(t.status) ||
    ["automatic", "dependency", "drill", "monitor", "merge", "recovery"].some(
      (k) => t[k] !== undefined
    ) ||
    (t.status === "discovering"
      ? g.status !== "reserved"
      : g.status !== "finished" || g.outcome !== t.status)
  )
    throw Error("Invalid discovery ticket provenance");
}
function checks(state, r, config) {
  const p = require("./policy.cjs");
  p.assertNotStopped(state);
  if (!c.contextOK(r)) throw Error("Unauthorized discovery invocation");
  if (
    !config.enabled ||
    !config.discovery ||
    !config.minutes ||
    !config.turns ||
    (r.event !== "workflow_dispatch" && !config.automatic)
  )
    throw Error("Discovery disabled");
  c.validateProof(r.discovery);
  if (
    !Number.isSafeInteger(r.ticket) ||
    r.ticket < 1 ||
    r.origin !== "discovery-sweep" ||
    r.head !== r.workflowSha ||
    ["head", "runId", "runAttempt", "workflowRef", "workflowSha"].some(
      (k) => r[k] !== r.discovery[k]
    )
  )
    throw Error("Invalid discovery provenance");
}
function reserveSweep(original, r, config, now = new Date()) {
  const p = require("./policy.cjs");
  checks(original, r, config);
  if (!c.FUNCTIONAL_CHARTERS.includes(r.discovery.charter))
    throw Error("Functional discovery charter required for a new reservation");
  if (original.tickets[String(r.ticket)]) throw Error("Discovery source already admitted");
  if (Object.values(original.tickets).some((t) => t.discovery?.key === r.discovery.key))
    throw Error("Duplicate discovery source");
  if (active.activeEntries(original).length >= config.concurrent)
    throw Error("No active discovery capacity");
  active.capacity(original, config.concurrent);
  const day = p.dayKey(now, config.timezone);
  if (day !== r.discovery.day) throw Error("Discovery day changed before reservation");
  if ((original.days[day] || []).length >= config.daily) throw Error("Daily ticket limit reached");
  if (
    Object.values(original.grants).filter(
      (g) => g.phase === "discover" && p.dayKey(new Date(g.at), config.timezone) === day
    ).length >= 2
  )
    throw Error("Discovery daily session limit reached");
  const state = structuredClone(original);
  state.days[day] = [...(state.days[day] || []), r.ticket];
  state.tickets[String(r.ticket)] = {
    coding: 0,
    reviews: 0,
    retries: 0,
    origin: "discovery-sweep",
    head: r.head,
    status: "discovering",
    pr: null,
    approval: null,
    discovery: structuredClone(r.discovery),
  };
  const grant = {
    id: randomUUID(),
    ticket: r.ticket,
    phase: "discover",
    slot: "discovery",
    runId: r.runId,
    runAttempt: 1,
    head: r.head,
    status: "reserved",
    at: now.toISOString(),
  };
  state.grants[grant.id] = grant;
  active.claimActive(state, { ticket: r.ticket, runId: r.runId, runAttempt: 1 }, config.concurrent);
  p.audit(
    state,
    "reserved",
    {
      ticket: r.ticket,
      grant: grant.id,
      phase: "discover",
      runId: r.runId,
      runAttempt: 1,
      actor: r.actor,
    },
    now
  );
  p.validateState(state);
  return { state, grant };
}
function preflightSweep(state, id, r, config) {
  checks(state, r, config);
  const g = state.grants[id];
  if (
    !g ||
    g.phase !== "discover" ||
    g.status !== "reserved" ||
    !active.owns(active.activeFor(state, g.ticket), g) ||
    ["ticket", "head", "runId", "runAttempt", "phase", "slot"].some((k) => g[k] !== r[k]) ||
    state.tickets[String(g.ticket)].discovery.key !== r.discovery.key
  )
    throw Error("Stale discovery reservation");
  active.capacity(state, config.concurrent);
  return g;
}
function finishSweep(original, id, outcome, now = new Date()) {
  const p = require("./policy.cjs");
  const s = structuredClone(original);
  const g = s.grants[id];
  if (
    !g ||
    g.phase !== "discover" ||
    g.status !== "reserved" ||
    !active.owns(active.activeFor(s, g.ticket), g) ||
    !["blocked", "discovery_complete"].includes(outcome.status) ||
    Object.keys(outcome).some((k) => k !== "status")
  )
    throw Error("Invalid discovery outcome");
  if (outcome.status !== "blocked") p.assertNotStopped(s);
  g.status = "finished";
  g.outcome = outcome.status;
  s.tickets[String(g.ticket)].status = outcome.status;
  active.releaseActive(s, g);
  p.audit(
    s,
    "finished",
    { ticket: g.ticket, grant: id, phase: "discover", status: outcome.status },
    now
  );
  p.validateState(s);
  return s;
}
module.exports = { ...c, validateTicket, reserveSweep, preflightSweep, finishSweep };
