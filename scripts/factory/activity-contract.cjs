const { REPOSITORY, SHA, ID, HASH, exact, digest } = require("./wake-contract.cjs");
const { secretLike } = require("./artifacts.cjs");
const WORKFLOWS = Object.freeze([
  "factory-agents.yml",
  "factory-automatic.yml",
  "factory-dependencies.yml",
  "factory-ci.yml",
  "factory-deploy.yml",
  "factory-monitor.yml",
  "factory-monitor-acknowledge.yml",
  "factory-monitor-drill.yml",
  "factory-pr-review.yml",
  "factory-activity.yml",
]);
const KINDS = Object.freeze([
  "issue",
  "monitor",
  "queue",
  "coding",
  "review",
  "discovery",
  "ci",
  "merge",
  "deployment",
  "stop",
  "budget",
  "monitor-stale",
  "monitor-recovered",
]);
const STATES = Object.freeze([
  "requested",
  "starting",
  "started",
  "completed",
  "success",
  "failure",
  "cancelled",
  "skipped",
  "held",
  "idle",
  "healthy",
  "unhealthy",
  "pending",
  "approved",
  "rejected",
  "merged",
  "stale",
  "recovered",
  "passed",
  "changes-requested",
  "no-findings",
  "queued",
  "blocked",
  "stopped",
]);
const MAX_EVENTS = 1400;
function validateProducer(p) {
  if (
    !exact(p, "runId,runAttempt,workflow,workflowSha,phase,actor") ||
    !ID.test(p.runId) ||
    !Number.isSafeInteger(p.runAttempt) ||
    p.runAttempt < 1 ||
    !WORKFLOWS.includes(p.workflow) ||
    !SHA.test(p.workflowSha) ||
    typeof p.phase !== "string" ||
    !/^[a-zA-Z0-9_ /:.-]{1,100}$/.test(p.phase) ||
    typeof p.actor !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9[\]-]{0,100}$/.test(p.actor)
  )
    throw Error("Invalid activity producer");
  return p;
}
function buildActivityEvent({ producer, kind, state, subject, head, summary, links = [] }) {
  validateProducer(producer);
  if (
    !KINDS.includes(kind) ||
    !STATES.includes(state) ||
    !Number.isSafeInteger(subject) ||
    subject < 1 ||
    !SHA.test(head) ||
    typeof summary !== "string" ||
    summary.length < 1 ||
    summary.length > 2000 ||
    /[\r\n`<>@]/.test(summary) ||
    secretLike(summary) ||
    /bearer\s+\S+|(?:password|token|secret|authorization)\s*[:=]\s*\S+/i.test(summary) ||
    !Array.isArray(links) ||
    links.length > 5 ||
    links.some(
      (l) =>
        typeof l !== "string" ||
        !new RegExp(
          `^https://github\\.com/${REPOSITORY}/(?:actions/runs/[1-9]\\d*(?:/job/[1-9]\\d*)?|issues/[1-9]\\d*|pull/[1-9]\\d*|commit/[a-f0-9]{40})$`
        ).test(l)
    )
  )
    throw Error("Invalid or secret-bearing activity event");
  const event = {
    producer: { ...producer },
    kind,
    state,
    subject,
    head,
    summary,
    links: [...links],
  };
  return { id: digest(event), ...event };
}
function validateEvent(e) {
  if (
    !exact(e, "id,producer,kind,state,subject,head,summary,links") ||
    buildActivityEvent(e).id !== e.id
  )
    throw Error("Invalid activity identity");
  return e;
}
function emptyActivity() {
  return { version: 1, repository: REPOSITORY, events: {}, lastMonitor: null, staleFor: null };
}
function validateActivity(s) {
  if (
    !exact(s, "version,repository,events,lastMonitor,staleFor") ||
    s.version !== 1 ||
    s.repository !== REPOSITORY ||
    !s.events ||
    typeof s.events !== "object" ||
    Array.isArray(s.events) ||
    Object.keys(s.events).length > MAX_EVENTS
  )
    throw Error("Invalid activity registry");
  for (const [id, r] of Object.entries(s.events)) {
    if (
      !HASH.test(id) ||
      !exact(r, "event,status,commentId") ||
      validateEvent(r.event).id !== id ||
      !["queued", "intent", "published"].includes(r.status) ||
      (r.status === "published"
        ? !Number.isSafeInteger(r.commentId) || r.commentId < 1
        : r.commentId !== null)
    )
      throw Error("Invalid activity receipt");
  }
  if (
    s.lastMonitor !== null &&
    (!exact(s.lastMonitor, "runId,at") ||
      !ID.test(s.lastMonitor.runId) ||
      !Number.isFinite(Date.parse(s.lastMonitor.at)))
  )
    throw Error("Invalid monitor freshness receipt");
  if (s.staleFor !== null && !ID.test(s.staleFor)) throw Error("Invalid monitor stale interval");
  return s;
}
function renderEvent(event) {
  validateEvent(event);
  const p = event.producer;
  const body = `<!-- factory-activity:${event.id} -->\n**${event.kind}: ${event.state}**\n\n${event.summary}\n\nSubject #${event.subject}; head \`${event.head}\`.\nProducer: ${p.workflow}, run ${p.runId}, attempt ${p.runAttempt}, phase ${p.phase}; actor ${p.actor}.\n\n${event.links.map((l) => `- ${l}`).join("\n")}\n`;
  if (Buffer.byteLength(body) > 8000 || secretLike(body)) throw Error("Activity body rejected");
  return body;
}
module.exports = {
  WORKFLOWS,
  KINDS,
  STATES,
  MAX_EVENTS,
  buildActivityEvent,
  validateProducer,
  validateEvent,
  emptyActivity,
  validateActivity,
  renderEvent,
};
