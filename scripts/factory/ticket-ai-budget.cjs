// A reservation spends one subscription session even if the runner is interrupted.
// The ledger validates both counters against its grants; no separate debit log is needed.
const DEFAULT_SESSIONS = 6;
const MAX_SESSIONS = 15;

function effectiveLimit(ticket, config) {
  const liveLimit = config.aiSessions ?? DEFAULT_SESSIONS;
  return Math.min(ticket.aiSessionLimit ?? liveLimit, liveLimit);
}

function canReserve(ticket, phase, config) {
  const remaining = effectiveLimit(ticket, config) - ticket.coding - ticket.reviews;
  return ticket.reviews < config.reviews && remaining >= (phase === "code" ? 2 : 1);
}

function reserve(ticket, request, config, grants) {
  if (!canReserve(ticket, request.phase, config))
    throw Error(
      "Automatic ticket AI budget limit reached or independent review allowance unavailable"
    );
  if (
    grants.some(
      (g) =>
        g.ticket === request.ticket &&
        g.runId === request.runId &&
        g.runAttempt === request.runAttempt &&
        g.phase === request.phase &&
        g.slot === request.slot
    )
  )
    throw Error("Automatic ticket AI session already reserved for this phase and run slot");
  ticket.aiSessionLimit ??= effectiveLimit(ticket, config);
}

function validate(ticket) {
  if (
    ticket.aiSessionLimit !== undefined &&
    (ticket.origin !== "factory" ||
      !Number.isSafeInteger(ticket.aiSessionLimit) ||
      ticket.aiSessionLimit < ticket.coding + ticket.reviews ||
      ticket.aiSessionLimit > MAX_SESSIONS)
  )
    throw Error("Invalid automatic ticket AI budget");
}

function checkPending(ticket, grant, config) {
  const remaining = effectiveLimit(ticket, config) - ticket.coding - ticket.reviews;
  if (
    remaining < 0 ||
    (grant.phase === "code" && (remaining < 1 || ticket.reviews >= config.reviews))
  )
    throw Error("Pending reservation exceeds current ticket AI budget");
}

module.exports = { DEFAULT_SESSIONS, MAX_SESSIONS, effectiveLimit, canReserve, reserve, validate, checkPending };
