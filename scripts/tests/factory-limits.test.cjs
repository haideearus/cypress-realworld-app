const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { GitHub, Ledger } = require("../factory/github.cjs");
const { vars, context, GitHubFixture } = require("./helpers/factory-fixtures.cjs");
const { exhaustedState, recoveryContext, now } = require("./helpers/factory-recovery-fixtures.cjs");

const raisedVars = {
  ...vars,
  FACTORY_MAX_TICKETS_PER_DAY: "20",
  FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "5",
  FACTORY_MAX_REVIEWS_PER_TICKET: "5",
  FACTORY_MAX_AUTOMATIC_RETRIES: "4",
  FACTORY_RUN_TIMEOUT_MINUTES: "30",
  FACTORY_MAX_TURNS_PER_RUN: "200",
};
function raisedConfig(change = {}) {
  return policy.readConfig({ ...raisedVars, ...change });
}
function consumedRecovery() {
  const legacy = policy.readConfig({
    ...vars,
    FACTORY_MAX_TICKETS_PER_DAY: "5",
    FACTORY_MAX_TURNS_PER_RUN: "100",
  });
  const saved = policy.reserve(exhaustedState(), recoveryContext(), legacy, now);
  return policy.finish(saved.state, saved.grant.id, { status: "blocked" }, now);
}
function ordinaryRecoveryRequest(overrides = {}) {
  return recoveryContext({ recovery: undefined, runId: "901", ...overrides });
}

test("approved higher ceilings accept configuration and reject each next value", () => {
  const config = raisedConfig();
  assert.deepEqual(
    [
      config.daily,
      config.coding,
      config.reviews,
      config.retries,
      config.concurrent,
      config.minutes,
      config.turns,
    ],
    [20, 5, 5, 4, 1, 30, 200]
  );
  for (const [key, value] of [
    ["FACTORY_MAX_TICKETS_PER_DAY", "21"],
    ["FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET", "6"],
    ["FACTORY_MAX_REVIEWS_PER_TICKET", "6"],
    ["FACTORY_MAX_AUTOMATIC_RETRIES", "5"],
    ["FACTORY_MAX_CONCURRENT_TICKETS", "2"],
    ["FACTORY_RUN_TIMEOUT_MINUTES", "31"],
    ["FACTORY_MAX_TURNS_PER_RUN", "201"],
  ])
    assert.throws(() => raisedConfig({ [key]: value }), /Invalid .*above approved limit/);
  assert.throws(() => raisedConfig({ FACTORY_MAX_CONCURRENT_TICKETS: "0" }), /concurrency/i);
});

test("ordinary tickets consume five lifetime coding attempts and four retries", () => {
  const config = raisedConfig();
  let state = policy.emptyState(policy.REPOSITORY);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const input = { ...context, runId: String(900 + attempt) };
    const saved = policy.reserve(state, input, config, now);
    assert.equal(saved.state.tickets["10"].coding, attempt);
    assert.equal(saved.state.tickets["10"].retries, attempt - 1);
    assert.equal(Object.keys(saved.state.grants).length, attempt);
    assert.doesNotThrow(() => policy.validateState(saved.state));
    assert.doesNotThrow(() => policy.preflight(saved.state, saved.grant.id, input, config));
    state = policy.finish(saved.state, saved.grant.id, { status: "blocked" }, now);
  }
  assert.throws(
    () =>
      policy.reserve(state, { ...context, runId: "906" }, config, new Date("2026-11-14T10:00:00Z")),
    /Coding attempt limit reached/
  );
  assert.equal(state.active, null);
  assert.deepEqual(state.days, { "2026-11-13": [10] });
});

test("a consumed legacy recovery admits ordinary attempts four and five without changing history", async () => {
  const config = raisedConfig();
  const original = consumedRecovery();
  const fixture = new GitHubFixture();
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  await ledger.update(() => ({ state: original }));
  let state;
  for (const [attempt, retries, runId] of [
    [4, 2, "901"],
    [5, 3, "902"],
  ]) {
    const input = ordinaryRecoveryRequest({ runId });
    const saved = await ledger.update((current) => policy.reserve(current, input, config, now));
    state = (await new Ledger(api).read()).state;
    assert.equal(state.tickets["11"].coding, attempt);
    assert.equal(state.tickets["11"].retries, retries);
    assert.equal(saved.grant.recovery, undefined);
    assert.equal(Object.values(state.grants).filter((g) => g.recovery !== undefined).length, 1);
    assert.deepEqual(state.tickets["11"].recovery, original.tickets["11"].recovery);
    assert.deepEqual(state.days, original.days);
    assert.deepEqual(state.audit.slice(0, original.audit.length), original.audit);
    for (const [id, grant] of Object.entries(original.grants))
      assert.deepEqual(state.grants[id], grant);
    assert.doesNotThrow(() => policy.preflight(state, saved.grant.id, input, config));
    await ledger.update((current) => ({
      state: policy.finish(current, saved.grant.id, { status: "blocked" }, now),
    }));
  }
  state = (await ledger.read()).state;
  assert.equal(state.active, null);
  assert.equal(Object.keys(state.grants).length, 5);
  assert.throws(
    () => policy.reserve(state, ordinaryRecoveryRequest({ runId: "903" }), config, now),
    /Coding attempt limit/
  );
  assert.throws(
    () => policy.reserve(state, recoveryContext({ runId: "903" }), config, now),
    /recovery/i
  );
  assert.equal(policy.MAX_CODING_ATTEMPTS, 5);
  const forged = structuredClone(state);
  const last = Object.values(forged.grants).find((g) => g.runId === "902");
  forged.grants.sixth = { ...last, id: "sixth", runId: "903" };
  forged.tickets["11"].coding = 6;
  forged.tickets["11"].retries = 4;
  assert.throws(() => policy.validateState(forged), /ledger ticket counters/i);
});

test("lower limits stop pending migrated attempts without invalidating their ledger", () => {
  const config = raisedConfig();
  const fourthInput = ordinaryRecoveryRequest();
  const fourth = policy.reserve(consumedRecovery(), fourthInput, config, now);
  const finished = policy.finish(fourth.state, fourth.grant.id, { status: "blocked" }, now);
  const fifthInput = ordinaryRecoveryRequest({ runId: "902" });
  const fifth = policy.reserve(finished, fifthInput, config, now);
  for (const [saved, input, changes] of [
    [
      fourth,
      fourthInput,
      {
        FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "2",
        FACTORY_MAX_AUTOMATIC_RETRIES: "1",
        FACTORY_MAX_REVIEWS_PER_TICKET: "2",
        FACTORY_MAX_TICKETS_PER_DAY: "5",
      },
    ],
    [fourth, fourthInput, { FACTORY_MAX_AUTOMATIC_RETRIES: "1" }],
    [fifth, fifthInput, { FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "4" }],
    [fifth, fifthInput, { FACTORY_MAX_AUTOMATIC_RETRIES: "2" }],
  ]) {
    assert.doesNotThrow(() => policy.validateState(saved.state));
    assert.throws(
      () => policy.preflight(saved.state, saved.grant.id, input, raisedConfig(changes)),
      /current limit/
    );
  }
});

test("recovered histories still reject deleted provenance and refunded counters", () => {
  const saved = policy.reserve(consumedRecovery(), ordinaryRecoveryRequest(), raisedConfig(), now);
  for (const mutate of [
    (s) => {
      delete s.tickets["11"].recovery;
    },
    (s) => {
      delete s.grants[s.tickets["11"].recovery.grant].recovery;
    },
    (s) => {
      s.tickets["11"].retries = 1;
    },
    (s) => {
      s.tickets["11"].coding = 3;
    },
    (s) => {
      s.tickets["11"].recovery.decision = "https://example.invalid/refund";
    },
  ]) {
    const state = structuredClone(saved.state);
    mutate(state);
    assert.throws(() => policy.validateState(state), /recovery|ledger/i);
  }
});

test("five lifetime reviews remain bounded for coding tickets and owner PRs", () => {
  const config = raisedConfig();
  for (const ownerPR of [false, true]) {
    let state = policy.emptyState(policy.REPOSITORY);
    if (!ownerPR) {
      const code = policy.reserve(state, context, config, now);
      state = policy.finish(code.state, code.grant.id, { status: "awaiting_review", pr: 20 }, now);
    }
    const input = {
      ...context,
      phase: "review",
      ...(ownerPR ? { origin: "owner-pr", pr: 20, slot: "existing" } : {}),
    };
    for (let review = 1; review <= 5; review++) {
      const saved = policy.reserve(state, input, config, now);
      assert.equal(saved.state.tickets["10"].reviews, review);
      assert.equal(saved.state.tickets["10"].coding, ownerPR ? 0 : 1);
      assert.doesNotThrow(() => policy.validateState(saved.state));
      if (review === 5)
        assert.throws(
          () =>
            policy.preflight(
              saved.state,
              saved.grant.id,
              input,
              raisedConfig({ FACTORY_MAX_REVIEWS_PER_TICKET: "4" })
            ),
          /current limit/
        );
      state = policy.finish(
        saved.state,
        saved.grant.id,
        { status: ownerPR ? "blocked" : "awaiting_review" },
        now
      );
    }
    assert.throws(() => policy.reserve(state, input, config, now), /Independent review limit/);
  }
});

test("raising ten admissions to twenty preserves history and refuses the twenty-first until Bucharest midnight", () => {
  const config = raisedConfig();
  const previousConfig = raisedConfig({ FACTORY_MAX_TICKETS_PER_DAY: "10" });
  let state = policy.emptyState(policy.REPOSITORY);
  let previousHistory;
  for (let ticket = 10; ticket < 30; ticket++) {
    const input = {
      ...context,
      ticket,
      runId: String(1000 + ticket),
      ...(ticket === 29 ? { phase: "review", origin: "owner-pr", pr: 40, slot: "existing" } : {}),
    };
    if (ticket === 20) {
      previousHistory = structuredClone(state);
      assert.throws(() => policy.reserve(state, input, previousConfig, now), /Daily ticket limit/);
      assert.deepEqual(state, previousHistory);
    }
    const saved = policy.reserve(state, input, ticket < 20 ? previousConfig : config, now);
    if (ticket === 20)
      assert.throws(
        () => policy.preflight(saved.state, saved.grant.id, input, previousConfig),
        /current limit/
      );
    state = policy.finish(saved.state, saved.grant.id, { status: "blocked" }, now);
  }
  assert.deepEqual(
    state.days["2026-11-13"],
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]
  );
  assert.deepEqual(state.days["2026-11-13"].slice(0, 10), previousHistory.days["2026-11-13"]);
  assert.deepEqual(state.audit.slice(0, previousHistory.audit.length), previousHistory.audit);
  for (const [id, grant] of Object.entries(previousHistory.grants))
    assert.deepEqual(state.grants[id], grant);
  for (const [id, ticket] of Object.entries(previousHistory.tickets))
    assert.deepEqual(state.tickets[id], ticket);
  assert.equal(state.tickets["29"].origin, "owner-pr");
  assert.equal(state.tickets["29"].coding, 0);
  assert.equal(state.tickets["29"].reviews, 1);
  assert.doesNotThrow(() => policy.validateState(state));
  const exhausted = structuredClone(state);
  assert.throws(
    () =>
      policy.reserve(state, { ...context, ticket: 30 }, config, new Date("2026-11-13T21:59:59Z")),
    /Daily ticket limit/
  );
  assert.deepEqual(state, exhausted);
  const next = policy.reserve(
    state,
    { ...context, ticket: 30 },
    config,
    new Date("2026-11-13T22:00:00Z")
  );
  assert.deepEqual(next.state.days["2026-11-14"], [30]);
  assert.deepEqual(next.state.days["2026-11-13"], exhausted.days["2026-11-13"]);
});
