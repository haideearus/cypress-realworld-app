const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { vars } = require("./helpers/factory-fixtures.cjs");
const {
  exhaustedState,
  recoveryContext,
  recoveryId,
  now,
} = require("./helpers/factory-recovery-fixtures.cjs");
const config = policy.readConfig({
  ...vars,
  FACTORY_MAX_TURNS_PER_RUN: "100",
  FACTORY_MAX_TICKETS_PER_DAY: "5",
});

const { GitHub, Ledger } = require("../factory/github.cjs");
const { Controller } = require("../factory/controller.cjs");
const { FactoryFixture, context } = require("./helpers/factory-fixtures.cjs");
const { issue } = require("./helpers/factory-recovery-fixtures.cjs");
async function controllerCase(overrides = {}) {
  const fixture = new FactoryFixture();
  fixture.issues.set(11, structuredClone(issue));
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  await ledger.update(() => ({ state: exhaustedState() }));
  const cfg = policy.readConfig({
    ...vars,
    FACTORY_MAX_TURNS_PER_RUN: "100",
    FACTORY_MAX_TICKETS_PER_DAY: "5",
    ...overrides,
  });
  const controller = new Controller(
    api,
    cfg,
    { ...context, runId: "900" },
    { sleep: async () => {}, maxPolls: 2 }
  );
  return { fixture, api, ledger, controller };
}

test("the real-shaped two-failure ledger remains valid without a recovery record", () => {
  assert.doesNotThrow(() => policy.validateState(exhaustedState()));
});
test("normal run stays exhausted and only explicit recovery reserves attempt three", () => {
  const state = exhaustedState(),
    input = recoveryContext();
  const normal = { ...input };
  delete normal.recovery;
  assert.throws(() => policy.reserve(state, normal, config, now), /limit reached/i);
  const saved = policy.reserve(state, input, config, now);
  assert.equal(saved.state.tickets["11"].coding, 3);
  assert.equal(saved.state.tickets["11"].retries, 1);
  assert.equal(saved.state.tickets["11"].reviews, 0);
  assert.deepEqual(saved.state.days, { "2026-11-12": [11] });
  assert.deepEqual(
    saved.state.grants["503b7bc1-d82f-4bd2-84e8-fae30886f23a"],
    state.grants["503b7bc1-d82f-4bd2-84e8-fae30886f23a"]
  );
  assert.deepEqual(
    saved.state.grants["2b3030da-263c-432e-9069-3f38d0778248"],
    state.grants["2b3030da-263c-432e-9069-3f38d0778248"]
  );
  assert.equal(saved.grant.recovery, recoveryId);
  assert.deepEqual(saved.state.tickets["11"].recovery, {
    id: recoveryId,
    grant: saved.grant.id,
    decision: "https://github.com/haideearus/cypress-realworld-app/issues/18",
  });
  assert.equal(state.tickets["11"].coding, 2);
  assert.ok(
    saved.state.audit.some(
      (a) => a.event === "recovery_reserved" && a.ticket === 11 && a.actor === "haideearus"
    )
  );
  assert.doesNotThrow(() => policy.validateState(saved.state));
  const workerInput = { ...input };
  delete workerInput.recovery;
  assert.doesNotThrow(() => policy.preflight(saved.state, saved.grant.id, workerInput, config));
});
test("one recovery is consumed even on failure and no normal or recovery fourth attempt exists", () => {
  const a = policy.reserve(exhaustedState(), recoveryContext(), config, now);
  const finished = policy.finish(a.state, a.grant.id, { status: "blocked" }, now);
  for (const recovery of [undefined, recoveryId])
    assert.throws(
      () => policy.reserve(finished, recoveryContext({ runId: "901", recovery }), config, now),
      /recovery|limit/i
    );
  assert.equal(finished.tickets["11"].coding, 3);
  assert.equal(finished.tickets["11"].retries, 1);
  assert.equal(Object.keys(finished.grants).length, 3);
});
test("disabled or lowered work budgets cannot receive or prepare a recovery", () => {
  for (const change of [
    { FACTORY_ENABLED: "false" },
    { FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "1" },
    { FACTORY_MAX_AUTOMATIC_RETRIES: "0" },
    { FACTORY_MAX_TURNS_PER_RUN: "0" },
    { FACTORY_MAX_TICKETS_PER_DAY: "0" },
    { FACTORY_MAX_TICKETS_PER_DAY: "4" },
    { FACTORY_MAX_REVIEWS_PER_TICKET: "0" },
    { FACTORY_MAX_REVIEWS_PER_TICKET: "1" },
    { FACTORY_RUN_TIMEOUT_MINUTES: "0" },
  ]) {
    const lowered = policy.readConfig({
      ...vars,
      FACTORY_MAX_TURNS_PER_RUN: "100",
      FACTORY_MAX_TICKETS_PER_DAY: "5",
      ...change,
    });
    assert.throws(
      () => policy.reserve(exhaustedState(), recoveryContext(), lowered, now),
      /disabled|recovery|limit/i
    );
    const a = policy.reserve(exhaustedState(), recoveryContext(), config, now);
    assert.throws(
      () => policy.preflight(a.state, a.grant.id, recoveryContext(), lowered),
      /disabled|limit/i
    );
  }
});
test("recovery refuses other tickets, roles, identities, flags and modified source history", () => {
  for (const change of [
    { ticket: 10 },
    { phase: "review" },
    { slot: "cycle2" },
    { actor: "outsider" },
    { event: "issue_comment" },
    { ref: "refs/heads/agent/test" },
    { recovery: "invented" },
    { recovery: false },
  ])
    assert.throws(
      () => policy.reserve(exhaustedState(), recoveryContext(change), config, now),
      /recovery|unauthorized|limit/i
    );
  for (const mutate of [
    (s) => {
      s.tickets["11"].criteriaHash = "b".repeat(64);
    },
    (s) => {
      s.tickets["11"].status = "retry";
    },
    (s) => {
      s.tickets["11"].pr = 30;
    },
    (s) => {
      s.grants["2b3030da-263c-432e-9069-3f38d0778248"].runId = "999";
    },
    (s) => {
      s.grants["2b3030da-263c-432e-9069-3f38d0778248"].outcome = "awaiting_review";
    },
  ]) {
    const s = exhaustedState();
    mutate(s);
    assert.throws(
      () => policy.reserve(s, recoveryContext(), config, now),
      /recovery|ledger|limit/i
    );
  }
});
test("an unrecognized recovery flag never silently creates an ordinary new ticket", () => {
  assert.throws(
    () =>
      policy.reserve(
        policy.emptyState("haideearus/cypress-realworld-app"),
        recoveryContext({ ticket: 10 }),
        config,
        now
      ),
    /recovery/i
  );
});
test("recovery cannot displace another active ticket or reuse a stale run attempt", () => {
  const occupied = policy.reserve(
    exhaustedState(),
    recoveryContext({ ticket: 10, recovery: undefined }),
    config,
    now
  );
  assert.throws(
    () => policy.reserve(occupied.state, recoveryContext({ runId: "901" }), config, now),
    /recovery|active/i
  );
  const a = policy.reserve(exhaustedState(), recoveryContext(), config, now);
  assert.throws(
    () => policy.preflight(a.state, a.grant.id, recoveryContext({ runAttempt: 2 }), config),
    /reservation/i
  );
  assert.throws(
    () => policy.preflight(a.state, a.grant.id, recoveryContext({ head: "c".repeat(40) }), config),
    /reservation/i
  );
});
test("forged recovery records and extra recovery grants fail validation", () => {
  const a = policy.reserve(exhaustedState(), recoveryContext(), config, now);
  for (const mutate of [
    (s) => {
      delete s.tickets["11"].recovery;
    },
    (s) => {
      delete s.grants[a.grant.id].recovery;
    },
    (s) => {
      s.tickets["11"].recovery.grant = "503b7bc1-d82f-4bd2-84e8-fae30886f23a";
    },
    (s) => {
      s.tickets["11"].recovery.decision = "https://example.invalid/fake";
    },
    (s) => {
      s.tickets["11"].criteriaHash = "b".repeat(64);
    },
    (s) => {
      s.grants["extra"] = { ...s.grants[a.grant.id], id: "extra" };
    },
  ]) {
    const s = structuredClone(a.state);
    mutate(s);
    assert.throws(() => policy.validateState(s), /recovery|ledger/i);
  }
});
test("recovery can reach a normal independent review without allowing an automatic retry", () => {
  const code = policy.reserve(exhaustedState(), recoveryContext(), config, now);
  let state = policy.finish(
    code.state,
    code.grant.id,
    { status: "awaiting_review", head: "b".repeat(40), pr: 30 },
    now
  );
  const reviewInput = recoveryContext({
    phase: "review",
    head: "b".repeat(40),
    recovery: undefined,
  });
  const review = policy.reserve(state, reviewInput, config, now);
  assert.doesNotThrow(() => policy.preflight(review.state, review.grant.id, reviewInput, config));
  state = policy.finish(
    review.state,
    review.grant.id,
    {
      status: "reviewed",
      head: "b".repeat(40),
      pr: 30,
      verdict: "pass",
      evidence: "https://github.com/haideearus/cypress-realworld-app/actions/runs/900",
    },
    now
  );
  assert.equal(policy.reviewGate(state, { number: 30, head: "b".repeat(40) }).ok, true);
  assert.equal(state.tickets["11"].coding, 3);
  assert.equal(state.tickets["11"].reviews, 1);
  assert.throws(
    () =>
      policy.reserve(state, recoveryContext({ runId: "901", recovery: undefined }), config, now),
    /reviewed|limit/i
  );
});

test("controller recovery starts from current main and disabled admission writes nothing", async () => {
  const disabled = await controllerCase({ FACTORY_ENABLED: "false" });
  const before = (await disabled.ledger.read()).state;
  assert.equal((await disabled.controller.admit(11, { recover: true })).ready, false);
  assert.deepEqual((await disabled.ledger.read()).state, before);
  const c = await controllerCase();
  await assert.rejects(c.controller.admit(11), /limit/i);
  const saved = await c.controller.admit(11, { recover: true });
  assert.equal(saved.ready, true);
  assert.equal(saved.head, "a".repeat(40));
  assert.notEqual(saved.head, exhaustedState().tickets["11"].head);
  assert.equal((await c.ledger.read()).state.tickets["11"].coding, 3);
});
test("controller recovery refuses edited criteria and orphaned publication", async () => {
  const changed = await controllerCase();
  changed.fixture.issues.get(11).body += " changed";
  await assert.rejects(changed.controller.admit(11, { recover: true }), /criteria|recovery/i);
  assert.equal((await changed.ledger.read()).state.tickets["11"].coding, 2);
  const orphan = await controllerCase();
  orphan.fixture.branchHeads.set("agent/factory-11", "c".repeat(40));
  await assert.rejects(orphan.controller.admit(11, { recover: true }), /orphan|publication/i);
});
test("the actual dispatch adapter distinguishes recover from ordinary run", async () => {
  const c = await controllerCase(),
    previousFetch = globalThis.fetch;
  const env = {
    FACTORY_OPERATION: "admit",
    FACTORY_VARIABLES: JSON.stringify({
      ...vars,
      FACTORY_MAX_TURNS_PER_RUN: "100",
      FACTORY_MAX_TICKETS_PER_DAY: "5",
    }),
    GH_TOKEN: "fixture-only",
    GITHUB_REPOSITORY: "haideearus/cypress-realworld-app",
    GITHUB_ACTOR: "haideearus",
    GITHUB_TRIGGERING_ACTOR: "haideearus",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ID: "900",
    GITHUB_RUN_ATTEMPT: "1",
  };
  globalThis.fetch = c.fixture.fetch;
  try {
    const { main } = require("../factory/controller.cjs");
    await assert.rejects(
      main({ ...env, FACTORY_INPUTS: JSON.stringify({ operation: "run", ticket: "11" }) }),
      /limit/i
    );
    const grant = await main({
      ...env,
      FACTORY_INPUTS: JSON.stringify({ operation: "recover", ticket: "11" }),
    });
    assert.equal(grant.ready, true);
    assert.equal(grant.ticket, 11);
    assert.equal((await c.ledger.read()).state.tickets["11"].coding, 3);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("owner cancellation preserves a consumed recovery and cannot refund another try", async () => {
  const c = await controllerCase();
  await c.controller.admit(11, { recover: true });
  const cancel = new Controller(
    c.api,
    config,
    { ...context, runId: "901" },
    { sleep: async () => {}, maxPolls: 2 }
  );
  assert.equal((await cancel.cancel()).canceled, true);
  const state = (await c.ledger.read()).state;
  assert.equal(state.active, null);
  assert.equal(state.tickets["11"].coding, 3);
  assert.equal(state.tickets["11"].retries, 1);
  assert.ok(state.tickets["11"].recovery);
  await assert.rejects(cancel.admit(11, { recover: true }), /recovery/i);
  assert.equal((await c.ledger.read()).state.tickets["11"].coding, 3);
});

test("recovery uses real publication CI and review flow and blocks automatic attempt four", async () => {
  for (const verdict of ["pass", "changes_requested"]) {
    const c = await controllerCase();
    const grant = await c.controller.admit(11, { recover: true });
    const published = await c.controller.publish(grant.grantId, {
      kind: "code",
      grantId: grant.grantId,
      base: grant.head,
      files: [
        {
          path: "src/recovery-fixture.ts",
          mode: "100644",
          content: "export const fixed = true;\n",
        },
      ],
      evidence: "RED: synthetic regression failed. GREEN: synthetic repair passed.",
    });
    const ci = await c.controller.ci(11);
    const reviewGrant = await c.controller.reserveReview(11, ci.runId, "cycle1");
    const head = published.head;
    const result = await c.controller.assess(
      11,
      { coding: "success", publication: "success", ci: "success", review: "success" },
      ci.runId,
      reviewGrant.grantId,
      {
        kind: "review",
        grantId: reviewGrant.grantId,
        base: head,
        result: {
          head,
          verdict,
          summary: "Synthetic review",
          findings:
            verdict === "pass"
              ? []
              : [{ severity: "important", message: "Synthetic changes requested" }],
        },
      },
      "cycle1"
    );
    assert.equal(result.retry, false);
    const state = (await c.ledger.read()).state;
    assert.equal(state.tickets["11"].coding, 3);
    assert.equal(state.tickets["11"].retries, 1);
    assert.equal(state.tickets["11"].reviews, 1);
    assert.equal(
      Object.values(state.grants).filter((g) => g.ticket === 11 && g.phase === "code").length,
      3
    );
    assert.equal(state.active, null);
    assert.equal(policy.reviewGate(state, { number: published.pr, head }).ok, verdict === "pass");
  }
});
