const policy = require("./policy.cjs");
const slots = require("./active-tickets.cjs");
const { terminalParent } = require("./active-runs.cjs");

const RETRY_DELAY = 5 * 60_000;
const RETRY_WINDOW = 25 * 60_000;
const MAX_QUOTA_DELAY = 65 * 60_000;
const RUN = /^[1-9]\d*$/;
const UUID = /^[a-f0-9-]{36}$/;
const TEMPORARY = new Set([500, 502, 503, 504]);
const STAGES = new Set([
  "ledger",
  "pr-identity",
  "saved-ci",
  "required-checks",
  "dependency-evidence",
  "final-preflight",
  "premerge",
]);
const UNKNOWN = "Check failed without a recognized safe reason";
const INCOMPLETE = "The retry ended before confirming a merge";
const QUOTA = "GitHub read quota exhausted";
const LEGACY_GATE = "Refreshed native review gate did not pass";
const CURRENT_GATE_UNAVAILABLE = "Current trusted review gate unavailable after refresh";
const REASONS = new Set([
  UNKNOWN,
  INCOMPLETE,
  QUOTA,
  "Dependency PR requires a current-main rebase",
  "Native review gate is pending or unavailable",
  "Native review gate run or attempt changed during refresh",
  "Native metadata gate identity changed before refresh",
  LEGACY_GATE,
  CURRENT_GATE_UNAVAILABLE,
  "Timed out waiting for the native review gate refresh",
  "Timed out waiting for clean PR mergeability after the native review gate refresh",
  "PR mergeability is not clean",
  "Native checks or clean PR mergeability changed",
  "Native required verify check is not successful",
  "Correlated exact-head factory CI failed",
  "CI run does not match its durable dispatch reservation",
  "CI does not cover the expected head or run attempt",
  "Automatic ticket identity, CI, or approval changed",
  "Merge intent changed concurrently",
  "Another merge intent holds the global merge writer",
  "An active ticket holds the factory lock",
  "Dependency head changed",
  "Daily held dependency merge limit reached",
  "Dependency PR has no changed package versions",
  "Wider dependency advisory clearance is no longer verified",
  "Dependency file exceeds source boundary",
  "Invalid dependency source encoding",
  "Dependency review required before premerge",
  "Dependency major update held",
  "Dependency major version or downgrade held",
  "Dependency downgrade held",
  "Forbidden manifest configuration change",
  "Dependency manifest sections changed",
  "Dependency manifest names changed",
  "Ambiguous dependency graph transition",
  "Incomplete candidate dependency edge",
  "OSV unavailable",
]);
const NATIVE_CHECK_REASON =
  /^(?:Missing native required check|Untrusted or stale native required check|Native check has no trusted Actions job|Native check does not belong to its trusted PR workflow|Native check does not identify its current workflow job): (?:verify|Factory review gate)$/;
const READ_ERROR = /^GitHub read failed \([45]\d\d\)$/;
const safeReason = (value) =>
  typeof value === "string" &&
  (REASONS.has(value) || NATIVE_CHECK_REASON.test(value) || READ_ERROR.test(value));
const timestamp = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const exact = (record, keys) => record && Object.keys(record).sort().join(",") === keys;

function readStatus(error) {
  return error?.method === "GET" &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599 &&
    error.message === `GitHub request failed (${error.status})`
    ? error.status
    : null;
}

function describe(error, stage) {
  const status = readStatus(error);
  const reason = status
    ? [403, 429].includes(status) && Number.isFinite(error.quotaResetAt)
      ? QUOTA
      : `GitHub read failed (${status})`
    : safeReason(error?.message)
      ? error.message
      : UNKNOWN;
  return { stage, reason };
}

class MergeCheckFailure extends Error {
  constructor(stage, cause) {
    super(cause?.message, { cause });
    this.diagnostic = describe(cause, stage);
  }
}

function retryTime(error, now) {
  if (
    error?.code === "FACTORY_VERIFIED_GATE_PENDING" &&
    error.message === "Native review gate is pending or unavailable"
  )
    return new Date(+now + RETRY_DELAY).toISOString();
  const status = readStatus(error);
  if (TEMPORARY.has(status)) return new Date(+now + RETRY_DELAY).toISOString();
  if (
    [403, 429].includes(status) &&
    Number.isFinite(error.quotaResetAt) &&
    error.quotaResetAt > +now &&
    error.quotaResetAt <= +now + MAX_QUOTA_DELAY
  )
    return new Date(Math.max(+now + RETRY_DELAY, error.quotaResetAt)).toISOString();
  return null;
}

function validate(ticket, attempts, grants) {
  const record = ticket.dependencyMergeRetry;
  if (record === undefined) return;
  if (
    !exact(record, "at,failure,grant,head,phase,retryAt,run,sourceRun") ||
    !attempts.some((attempt) => attempt.head === record.head) ||
    !UUID.test(record.grant || "") ||
    (grants.length &&
      !grants.some(
        (g) =>
          g.id === record.grant &&
          g.head === record.head &&
          g.status === "finished" &&
          g.outcome === "reviewed"
      )) ||
    !RUN.test(record.sourceRun || "") ||
    !timestamp(record.at) ||
    !exact(record.failure, "reason,stage") ||
    !STAGES.has(record.failure.stage) ||
    !safeReason(record.failure.reason) ||
    !["queued", "retrying", "held"].includes(record.phase) ||
    (record.retryAt !== null && (!timestamp(record.retryAt) || record.retryAt <= record.at)) ||
    (record.phase === "queued" && (!record.retryAt || record.run !== null)) ||
    (record.phase === "retrying" && !record.run) ||
    (record.run !== null &&
      (!record.retryAt ||
        !exact(record.run, "at,runAttempt,runId,workflowSha") ||
        !RUN.test(record.run.runId || "") ||
        record.run.runId === record.sourceRun ||
        record.run.runAttempt !== 1 ||
        !policy.SHA.test(record.run.workflowSha || "") ||
        !timestamp(record.run.at) ||
        record.run.at < record.retryAt))
  )
    throw Error("Invalid dependency merge retry receipt");
}

function current(ticket) {
  const record = ticket?.dependencyMergeRetry;
  return record &&
    ticket.status === "reviewed" &&
    ticket.approval?.head === ticket.head &&
    record.head === ticket.head &&
    record.grant === ticket.approval.grant
    ? record
    : null;
}

function blocksQueue(ticket, now = new Date()) {
  if (ticket.merge?.status === "intent") return true;
  const record = current(ticket);
  if (!record) return true;
  return record.phase === "retrying" && Date.parse(record.run.at) + RETRY_WINDOW > +now;
}

function due(ticket, now) {
  const record = current(ticket);
  return record?.phase === "queued" && Date.parse(record.retryAt) <= +now;
}

function heldGate(ticket) {
  const record = current(ticket);
  return Boolean(
    record?.phase === "held" &&
      record.run === null &&
      record.retryAt === null &&
      record.failure.stage === "required-checks" &&
      record.failure.reason === LEGACY_GATE
  );
}

function owner(record, context) {
  const run = record?.run;
  return (
    run?.runId === context.runId &&
    run.runAttempt === context.runAttempt &&
    run.workflowSha === context.workflowSha
  );
}

function permits(ticket, context, now = new Date()) {
  const record = current(ticket);
  return (
    !record ||
    (record.phase === "retrying" &&
      owner(record, context) &&
      Date.parse(record.run.at) + RETRY_WINDOW > +now)
  );
}

function recordUnsent(ticket, intent, error, now = new Date()) {
  const diagnostic =
    error instanceof MergeCheckFailure ? error.diagnostic : describe(error, "final-preflight");
  return recordFailure(ticket, intent, diagnostic, retryTime(error?.cause ?? error, now), now);
}

function recordFailure(ticket, context, diagnostic, retryAt, now) {
  const previous = current(ticket);
  const trustedGateRefreshUnavailable = diagnostic.reason === CURRENT_GATE_UNAVAILABLE;
  // Old in-flight controllers validate fixed receipt reasons across the entire
  // ledger. Retain the compatible reason and keep new detail in the audit row.
  const failure = trustedGateRefreshUnavailable
    ? { ...diagnostic, reason: LEGACY_GATE }
    : diagnostic;
  ticket.dependencyMergeRetry = previous
    ? { ...previous, phase: "held", failure }
    : {
        head: ticket.head,
        grant: ticket.approval.grant,
        at: now.toISOString(),
        phase: retryAt ? "queued" : "held",
        failure,
        retryAt,
        sourceRun: context.runId,
        run: null,
      };
  return {
    failure,
    recovery: ticket.dependencyMergeRetry.phase,
    retryAt: ticket.dependencyMergeRetry.retryAt,
    ...(trustedGateRefreshUnavailable ? { trustedGateRefreshUnavailable: true } : {}),
  };
}

class RetryUnavailable extends Error {}
async function claim(ledger, ticket, context, config, now, verifyHeldGate) {
  if (!config.autoMerge || context.runAttempt !== 1) return false;
  try {
    await ledger.update(async (state) => {
      policy.assertNotStopped(state);
      const t = state.tickets[ticket.pr];
      const record = current(t);
      const recoverGate = typeof verifyHeldGate === "function" && heldGate(t);
      if (
        (!recoverGate && !due(t, now)) ||
        record.sourceRun === context.runId ||
        JSON.stringify(t) !== JSON.stringify(ticket) ||
        slots.pendingIntent(state) ||
        !slots.capacity(state, config.concurrent)
      )
        throw new RetryUnavailable();
      if (recoverGate) {
        if (
          +now <= Date.parse(record.at) ||
          !policy.reviewGate(state, { number: t.pr, head: t.head }).ok
        )
          throw new RetryUnavailable();
        await verifyHeldGate(t);
        slots.claimActive(
          state,
          { ticket: t.pr, runId: context.runId, runAttempt: context.runAttempt },
          config.concurrent
        );
        record.retryAt = now.toISOString();
      }
      record.phase = "retrying";
      record.run = {
        at: now.toISOString(),
        runId: context.runId,
        runAttempt: context.runAttempt,
        workflowSha: context.workflowSha,
      };
      policy.audit(
        state,
        "dependency_merge_retry_claimed",
        { ticket: t.pr, head: t.head, runId: context.runId },
        now
      );
      return { state };
    });
  } catch (error) {
    if (error instanceof RetryUnavailable) return false;
    throw error;
  }
  return true;
}

async function initialFailure(ledger, ticket, context, error, { temporaryOnly = false } = {}) {
  if (!(error instanceof MergeCheckFailure)) return;
  const now = new Date();
  const retryAt = retryTime(error.cause, now);
  if (temporaryOnly && !retryAt) return;
  await holdBeforeIntent(ledger, ticket, context, error.diagnostic, retryAt, now);
}

async function holdBeforeIntent(ledger, ticket, context, diagnostic, retryAt, now) {
  try {
    await ledger.update(async (state) => {
      const t = state.tickets[ticket.pr];
      const active = slots.activeFor(state, ticket.pr);
      if (
        state.stop ||
        t?.merge ||
        t?.status !== "reviewed" ||
        !t.approval ||
        !permits(t, context, now) ||
        JSON.stringify(t) !== JSON.stringify(ticket)
      )
        throw new RetryUnavailable();
      if (active && !slots.owns(active, { ...context, ticket: ticket.pr })) {
        const parent = t.dependency.attempts.at(-1);
        if (
          !slots.owns(active, { ...parent, ticket: t.pr }) ||
          !(await terminalParent(ledger.api, active))
        )
          throw new RetryUnavailable();
      }
      const detail = recordFailure(t, context, diagnostic, retryAt, now);
      if (active) slots.releaseActive(state, active);
      policy.audit(
        state,
        "dependency_merge_preflight_held",
        { ticket: t.pr, head: t.head, runId: context.runId, ...detail },
        now
      );
      return { state };
    });
  } catch (reason) {
    if (!(reason instanceof RetryUnavailable)) throw reason;
    return false;
  }
  return true;
}

function premergeEvidence(error, now = new Date()) {
  return { failure: describe(error, "premerge"), retryAt: retryTime(error, now) };
}

async function premergeFailed(ledger, t, context, head, evidence) {
  if (t?.status !== "reviewed" || t.head !== head || t.merge) return false;
  const now = new Date();
  let reported;
  if (typeof evidence === "string" && evidence.length <= 500) {
    try {
      reported = JSON.parse(evidence);
    } catch {}
  }
  const diagnostic =
    reported?.failure?.stage === "premerge" && safeReason(reported.failure.reason)
      ? { stage: "premerge", reason: reported.failure.reason }
      : { stage: "premerge", reason: UNKNOWN };
  const retryAt =
    timestamp(reported?.retryAt) &&
    Date.parse(reported.retryAt) <= +now + MAX_QUOTA_DELAY &&
    (diagnostic.reason === QUOTA ||
      [...TEMPORARY].some((status) => diagnostic.reason === `GitHub read failed (${status})`))
      ? new Date(Math.max(+now + RETRY_DELAY, Date.parse(reported.retryAt))).toISOString()
      : null;
  return holdBeforeIntent(ledger, t, context, diagnostic, retryAt, now);
}

async function finish(ledger, t, context) {
  const record = current(t);
  if (t?.merge || record?.phase !== "retrying" || !owner(record, context)) return false;
  try {
    await ledger.update((next) => {
      const latest = next.tickets[t.pr];
      const retry = current(latest);
      if (latest?.merge || retry?.phase !== "retrying" || !owner(retry, context))
        throw new RetryUnavailable();
      const active = slots.activeFor(next, t.pr);
      if (active && !slots.owns(active, { ...context, ticket: t.pr })) throw new RetryUnavailable();
      if (active) slots.releaseActive(next, active);
      retry.phase = "held";
      retry.failure = { stage: "premerge", reason: INCOMPLETE };
      policy.audit(next, "dependency_merge_retry_ended_unsent", {
        ticket: t.pr,
        head: latest.head,
        runId: context.runId,
      });
      return { state: next };
    });
  } catch (error) {
    if (error instanceof RetryUnavailable) return false;
    throw error;
  }
  return true;
}

module.exports = {
  MergeCheckFailure,
  describe,
  validate,
  current,
  blocksQueue,
  due,
  heldGate,
  permits,
  recordUnsent,
  claim,
  initialFailure,
  premergeEvidence,
  premergeFailed,
  finish,
};
