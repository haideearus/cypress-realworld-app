const test = require("node:test");
const assert = require("node:assert/strict");
let policy;
try {
  policy = require("../factory/policy.cjs");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
const vars = {
  FACTORY_ENABLED: "true",
  FACTORY_MAX_TICKETS_PER_DAY: "2",
  FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "2",
  FACTORY_MAX_REVIEWS_PER_TICKET: "2",
  FACTORY_MAX_AUTOMATIC_RETRIES: "1",
  FACTORY_MAX_CONCURRENT_TICKETS: "1",
  FACTORY_TIMEZONE: "Europe/Bucharest",
  FACTORY_RUN_TIMEOUT_MINUTES: "15",
  FACTORY_MAX_TURNS_PER_RUN: "20",
  FACTORY_APP_URL: "https://haide-software-factory.onrender.com",
};
const head = "a".repeat(40);
function setup(overrides = {}) {
  const config = policy.readConfig({ ...vars, ...overrides });
  return { config, state: policy.emptyState("haideearus/cypress-realworld-app") };
}
function request(overrides = {}) {
  return {
    repository: "haideearus/cypress-realworld-app",
    actor: "haideearus",
    triggeringActor: "haideearus",
    ref: "refs/heads/main",
    event: "workflow_dispatch",
    runId: "100",
    runAttempt: 1,
    ticket: 10,
    phase: "code",
    slot: "cycle1",
    head,
    ...overrides,
  };
}
const now = new Date("2026-11-11T20:00:00Z");

test("factory policy is installed", () =>
  assert.ok(policy, "missing factory policy implementation"));
test("disabled and absent enabled flag refuse a coding reservation", () => {
  for (const flag of ["false", undefined]) {
    const { config, state } = setup({ FACTORY_ENABLED: flag });
    assert.throws(() => policy.reserve(state, request(), config, now), /disabled/i);
    assert.deepEqual(state.days, {});
  }
});
test("invalid, missing and increased limits fail closed", () => {
  for (const value of ["6", "999", "2x", "-1", "1.5", "", undefined])
    assert.throws(() => policy.readConfig({ ...vars, FACTORY_MAX_TICKETS_PER_DAY: value }));
  assert.throws(() => policy.readConfig({ ...vars, FACTORY_TIMEZONE: "UTC" }));
  assert.throws(() => policy.readConfig({ ...vars, FACTORY_MAX_CONCURRENT_TICKETS: "2" }));
});
test("turn budgets up to one hundred remain usable and preserve other approved caps", () => {
  for (const value of ["1", "20", "50", "100"]) {
    const { config, state } = setup({ FACTORY_MAX_TURNS_PER_RUN: value });
    assert.equal(config.turns, Number(value));
    assert.equal(config.minutes, 15);
    assert.equal(config.daily, 2);
    assert.equal(config.coding, 2);
    assert.equal(config.reviews, 2);
    assert.equal(config.retries, 1);
    assert.equal(config.concurrent, 1);
    const saved = policy.reserve(state, request(), config, now);
    assert.equal(saved.state.tickets["10"].coding, 1);
    assert.equal(saved.state.tickets["10"].reviews, 0);
  }
});
test("turn budgets above one hundred or malformed budgets refuse configuration", () => {
  for (const value of ["101", "999", "-1", "1.5", "100x", "", undefined])
    assert.throws(
      () => policy.readConfig({ ...vars, FACTORY_MAX_TURNS_PER_RUN: value }),
      /Invalid FACTORY_MAX_TURNS_PER_RUN/
    );
});
test("hundred-turn policy still refuses disabled work and a zero turn budget", () => {
  for (const overrides of [
    { FACTORY_MAX_TURNS_PER_RUN: "100", FACTORY_ENABLED: "false" },
    { FACTORY_MAX_TURNS_PER_RUN: "0" },
  ]) {
    const { config, state } = setup(overrides);
    assert.throws(() => policy.reserve(state, request(), config, now), /disabled/i);
    assert.equal(state.active, null);
    assert.deepEqual(state.days, {});
  }
});
test("zero limit stops work rather than being replaced by a default", () => {
  const { config, state } = setup({ FACTORY_MAX_TICKETS_PER_DAY: "0" });
  assert.throws(() => policy.reserve(state, request(), config, now), /daily/i);
});
test("API keys, alternative auth and paid provider routes are rejected", () => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_PROFILE",
  ])
    assert.throws(
      () => policy.assertSubscriptionEnv({ [name]: "not-a-real-credential" }),
      /subscription/i
    );
  assert.doesNotThrow(() =>
    policy.assertSubscriptionEnv({ CLAUDE_CODE_OAUTH_TOKEN: "fixture-only" }, true)
  );
  assert.throws(() => policy.assertSubscriptionEnv({}, true), /subscription/i);
});
test("untrusted actor, fork, event and non-main dispatch cannot reserve work", () => {
  for (const change of [
    { actor: "outsider" },
    { triggeringActor: "outsider" },
    { event: "issue_comment" },
    { ref: "refs/heads/agent/anything" },
    { repository: "outsider/cypress-realworld-app" },
  ]) {
    const { state, config } = setup();
    assert.throws(() => policy.reserve(state, request(change), config, now), /unauthorized/i);
  }
});
test("reservation records counters before execution and binds the run attempt", () => {
  const { state, config } = setup();
  const result = policy.reserve(state, request(), config, now);
  assert.equal(result.state.tickets["10"].coding, 1);
  assert.deepEqual(result.state.days, { "2026-11-11": [10] });
  assert.equal(result.grant.runAttempt, 1);
  assert.equal(result.grant.head, head);
  assert.equal(state.active, null, "pure transition must not mutate caller state");
  assert.doesNotThrow(() => policy.preflight(result.state, result.grant.id, request(), config));
  assert.throws(
    () => policy.preflight(result.state, result.grant.id, request({ runAttempt: 2 }), config),
    /reservation/i
  );
  assert.throws(
    () =>
      policy.preflight(result.state, result.grant.id, request({ head: "b".repeat(40) }), config),
    /reservation/i
  );
});
test("one active ticket blocks another and an unfinished invocation blocks duplicate work", () => {
  const { state, config } = setup();
  const first = policy.reserve(state, request(), config, now);
  assert.throws(() => policy.reserve(first.state, request({ ticket: 11 }), config, now), /active/i);
  assert.throws(() => policy.reserve(first.state, request(), config, now), /reservation/i);
});
test("third new ticket is blocked on the same day but can start after Bucharest midnight", () => {
  const { config } = setup();
  let state = policy.emptyState("haideearus/cypress-realworld-app");
  for (const ticket of [10, 11]) {
    const result = policy.reserve(state, request({ ticket }), config, now);
    state = policy.finish(result.state, result.grant.id, { status: "blocked" }, now);
  }
  assert.throws(
    () => policy.reserve(state, request({ ticket: 12 }), config, new Date("2026-11-11T21:59:59Z")),
    /daily/i
  );
  const next = policy.reserve(
    state,
    request({ ticket: 12 }),
    config,
    new Date("2026-11-11T22:00:00Z")
  );
  assert.deepEqual(next.state.days["2026-11-12"], [12]);
});
test("five daily tickets include owner reviews and the sixth waits for Bucharest midnight", () => {
  const { config } = setup({ FACTORY_MAX_TICKETS_PER_DAY: "5", FACTORY_MAX_TURNS_PER_RUN: "50" });
  let state = policy.emptyState("haideearus/cypress-realworld-app");
  for (const ticket of [10, 11, 12, 13, 14]) {
    const input =
      ticket === 14
        ? request({ ticket, phase: "review", origin: "owner-pr", pr: 30, slot: "existing" })
        : request({ ticket });
    const saved = policy.reserve(state, input, config, now);
    state = policy.finish(saved.state, saved.grant.id, { status: "blocked" }, now);
  }
  assert.deepEqual(state.days["2026-11-11"], [10, 11, 12, 13, 14]);
  assert.equal(state.tickets["14"].coding, 0);
  assert.equal(state.tickets["14"].reviews, 1);
  assert.throws(
    () => policy.reserve(state, request({ ticket: 15 }), config, new Date("2026-11-11T21:59:59Z")),
    /daily/i
  );
  const next = policy.reserve(
    state,
    request({ ticket: 15 }),
    config,
    new Date("2026-11-11T22:00:00Z")
  );
  assert.deepEqual(next.state.days["2026-11-12"], [15]);
  assert.deepEqual(next.state.days["2026-11-11"], [10, 11, 12, 13, 14]);
});

test("retrying an admitted ticket at the five-ticket cap preserves lifetime usage", () => {
  const { config } = setup({ FACTORY_MAX_TICKETS_PER_DAY: "5", FACTORY_MAX_TURNS_PER_RUN: "50" });
  let state = policy.emptyState("haideearus/cypress-realworld-app");
  for (const ticket of [10, 11, 12, 13, 14]) {
    const saved = policy.reserve(state, request({ ticket }), config, now);
    state = policy.finish(saved.state, saved.grant.id, { status: "blocked" }, now);
  }
  const retry = policy.reserve(state, request({ runId: "101" }), config, now);
  assert.deepEqual(retry.state.days["2026-11-11"], [10, 11, 12, 13, 14]);
  assert.equal(retry.state.tickets["10"].coding, 2);
  assert.equal(retry.state.tickets["10"].retries, 1);
  assert.equal(retry.state.tickets["10"].reviews, 0);
  state = policy.finish(retry.state, retry.grant.id, { status: "blocked" }, now);
  assert.throws(
    () =>
      policy.reserve(state, request({ runId: "102" }), config, new Date("2026-11-12T12:00:00Z")),
    /coding/i
  );
});

test("two coding attempts include one retry and persist across days", () => {
  const { config, state } = setup();
  let a = policy.reserve(state, request(), config, now);
  let s = policy.finish(a.state, a.grant.id, { status: "retry", head }, now);
  a = policy.reserve(s, request({ slot: "cycle2" }), config, now);
  assert.equal(a.state.tickets["10"].coding, 2);
  assert.equal(a.state.tickets["10"].retries, 1);
  s = policy.finish(a.state, a.grant.id, { status: "blocked" }, now);
  assert.throws(
    () => policy.reserve(s, request({ runId: "101" }), config, new Date("2026-11-12T12:00:00Z")),
    /coding/i
  );
});
test("a retry is refused when the configured retry allowance is zero", () => {
  const { config, state } = setup({ FACTORY_MAX_AUTOMATIC_RETRIES: "0" });
  const a = policy.reserve(state, request(), config, now);
  const s = policy.finish(a.state, a.grant.id, { status: "blocked" }, now);
  assert.throws(() => policy.reserve(s, request({ runId: "101" }), config, now), /retry/i);
});
test("review requires the matching active coding ticket and is bounded to two lifetime invocations", () => {
  const { state, config } = setup();
  assert.throws(
    () => policy.reserve(state, request({ phase: "review" }), config, now),
    /coding|active/i
  );
  let a = policy.reserve(state, request(), config, now);
  let s = policy.finish(a.state, a.grant.id, { status: "awaiting_review", head, pr: 20 }, now);
  a = policy.reserve(s, request({ phase: "review" }), config, now);
  s = policy.finish(a.state, a.grant.id, { status: "awaiting_review" }, now);
  a = policy.reserve(s, request({ phase: "review", slot: "review2" }), config, now);
  s = policy.finish(a.state, a.grant.id, { status: "awaiting_review" }, now);
  assert.throws(
    () => policy.reserve(s, request({ phase: "review", slot: "review3" }), config, now),
    /review/i
  );
});
test("owner PR review reserves the same budget without inventing a coding invocation", () => {
  const { state, config } = setup();
  const input = request({ phase: "review", origin: "owner-pr", pr: 30, slot: "existing" });
  let saved = policy.reserve(state, input, config, now);
  assert.equal(saved.state.tickets["10"].coding, 0);
  assert.equal(saved.state.tickets["10"].reviews, 1);
  assert.deepEqual(saved.state.days["2026-11-11"], [10]);
  assert.doesNotThrow(() => policy.validateState(saved.state));
  assert.throws(() => policy.reserve(saved.state, request({ ticket: 11 }), config, now), /active/i);
  let next = policy.finish(
    saved.state,
    saved.grant.id,
    {
      status: "reviewed",
      head,
      pr: 30,
      verdict: "pass",
      evidence: "https://github.com/haideearus/cypress-realworld-app/actions/runs/100",
    },
    now
  );
  assert.equal(policy.reviewGate(next, { number: 30, head }).ok, true);
  saved = policy.reserve(next, { ...input, runId: "101", head: "b".repeat(40) }, config, now);
  assert.equal(policy.reviewGate(saved.state, { number: 30, head }).ok, false);
  next = policy.finish(saved.state, saved.grant.id, { status: "blocked" }, now);
  assert.throws(
    () => policy.reserve(next, { ...input, runId: "102" }, config, now),
    /review.*limit/i
  );
  assert.throws(
    () => policy.reserve(state, { ...input, actor: "outsider" }, config, now),
    /unauthorized/i
  );
  assert.throws(() => policy.reserve(state, { ...input, pr: 0 }, config, now), /PR/i);
});
test("a coding ticket cannot be reclassified as an owner PR to bypass its history", () => {
  const { state, config } = setup();
  const saved = policy.reserve(state, request(), config, now);
  const next = policy.finish(saved.state, saved.grant.id, { status: "blocked" }, now);
  assert.throws(
    () =>
      policy.reserve(
        next,
        request({
          phase: "review",
          origin: "owner-pr",
          pr: 30,
          slot: "existing",
          runId: "101",
        }),
        config,
        now
      ),
    /origin|mode|owner/i
  );
});
test("gate rejects absent, fake, stale and failed review evidence", () => {
  const { state, config } = setup();
  let a = policy.reserve(state, request(), config, now);
  let s = policy.finish(a.state, a.grant.id, { status: "awaiting_review", head, pr: 20 }, now);
  assert.equal(policy.reviewGate(s, { number: 20, head }).ok, false);
  a = policy.reserve(s, request({ phase: "review" }), config, now);
  s = policy.finish(
    a.state,
    a.grant.id,
    {
      status: "reviewed",
      head,
      pr: 20,
      verdict: "pass",
      evidence: "https://github.com/haideearus/cypress-realworld-app/actions/runs/100",
    },
    now
  );
  assert.equal(policy.reviewGate(s, { number: 20, head }).ok, true);
  assert.equal(policy.reviewGate(s, { number: 20, head: "b".repeat(40) }).ok, false);
  assert.equal(policy.reviewGate(s, { number: 21, head }).ok, false);
  const fake = structuredClone(s);
  fake.tickets["10"].approval.fixture = true;
  assert.equal(policy.reviewGate(fake, { number: 20, head }).ok, false);
});
test("malformed or foreign ledger state is refused, never initialized implicitly", () => {
  const { config } = setup();
  for (const state of [
    null,
    {},
    { ...policy.emptyState("other/repo") },
    { ...policy.emptyState("haideearus/cypress-realworld-app"), version: 0 },
  ])
    assert.throws(() => policy.reserve(state, request(), config, now), /state|ledger/i);
});

module.exports = { vars, request, head, now };

test("corrupted collections or missing reservation history cannot reset usage counters", () => {
  const { state, config } = setup();
  for (const key of ["days", "tickets", "grants"])
    assert.throws(() => policy.validateState({ ...state, [key]: [] }), /ledger/i);
  const saved = policy.reserve(state, request(), config, now);
  const missingHistory = structuredClone(saved.state);
  missingHistory.grants = {};
  assert.throws(() => policy.validateState(missingHistory), /ledger/i);
  const missingAdmission = structuredClone(saved.state);
  missingAdmission.days = {};
  assert.throws(() => policy.validateState(missingAdmission), /ledger/i);
});
test("lowering a limit refuses a pending invocation instead of grandfathering a new model call", () => {
  const { state, config } = setup();
  const saved = policy.reserve(state, request(), config, now);
  const lowered = policy.readConfig({ ...vars, FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "0" });
  assert.throws(() => policy.preflight(saved.state, saved.grant.id, request(), lowered), /limit/i);
});
