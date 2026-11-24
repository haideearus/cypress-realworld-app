const p = require("./policy.cjs");
const c = require("./feature-contract.cjs");

const MAX_WAIT = 24 * 60 * 60 * 1000;
const SELECTION_TIMEOUT = 5 * 60 * 1000;
const WAITING = "A scheduled feature turn is next";
const TESTED_MAIN = "Feature turn awaits passing CI on current main";
const iso = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function validate(turn) {
  if (turn === undefined) return;
  if (
    !c.exact(turn, "runId,mode,at,attemptAt,retryAt,status,ticket") ||
    !c.RUN.test(turn.runId || "") ||
    !["pilot", "live"].includes(turn.mode) ||
    !iso(turn.at) ||
    (turn.attemptAt !== null && (!iso(turn.attemptAt) || turn.attemptAt < turn.at)) ||
    (turn.retryAt !== null && (!iso(turn.retryAt) || turn.retryAt < turn.at)) ||
    !["waiting", "finished"].includes(turn.status) ||
    (turn.ticket !== null && (!Number.isSafeInteger(turn.ticket) || turn.ticket < 1))
  )
    throw Error("Invalid feature turn");
}

function pending(state, config, now = new Date()) {
  const turn = state.featureTurn;
  if (
    !state.stop &&
    config.enabled &&
    config.automatic &&
    turn?.status === "waiting" &&
    turn.mode === config.featureMode &&
    now.getTime() < Date.parse(turn.at) + MAX_WAIT
  )
    return turn;
  return null;
}

function eligible(state, config, now = new Date(), { ignoreDelay = false } = {}) {
  const turn = pending(state, config, now);
  return turn &&
    config.minutes > 0 &&
    config.turns > 0 &&
    (!turn.ticket || config.coding > 0) &&
    (ignoreDelay || !turn.retryAt || Date.parse(turn.retryAt) <= now.getTime()) &&
    p.dailyAdmissions(state, p.dayKey(now, c.TIMEZONE)) < config.daily
    ? turn
    : null;
}

function priority(state, config, now = new Date()) {
  const turn = eligible(state, config, now);
  return turn && (!turn.attemptAt || now.getTime() < Date.parse(turn.attemptAt) + SELECTION_TIMEOUT)
    ? turn
    : null;
}

function retryTime(now, quota) {
  const reset = quota?.reset;
  return new Date(
    Number.isSafeInteger(reset) && reset > now.getTime()
      ? reset + 1000
      : now.getTime() + SELECTION_TIMEOUT
  ).toISOString();
}

function enqueue(state, config, runId, now = new Date()) {
  if (pending(state, config, now) || state.featureTurn?.runId === runId) return false;
  const turn = {
    runId,
    mode: config.featureMode,
    at: now.toISOString(),
    attemptAt: null,
    retryAt: null,
    status: "waiting",
    ticket: null,
  };
  validate(turn);
  state.featureTurn = turn;
  return true;
}

function update(state, runId, change) {
  if (state.featureTurn?.runId !== runId || state.featureTurn.status !== "waiting") return false;
  const turn = { ...state.featureTurn, ...change };
  validate(turn);
  state.featureTurn = turn;
  return true;
}

module.exports = {
  WAITING,
  TESTED_MAIN,
  validate,
  pending,
  eligible,
  priority,
  retryTime,
  enqueue,
  update,
};
