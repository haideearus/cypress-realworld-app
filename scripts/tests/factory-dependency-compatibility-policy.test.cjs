const { test } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const dep = require("../factory/dependency-policy.cjs");
const contract = require("../factory/dependency-contract.cjs");
const { vars, context, head: base } = require("./helpers/factory-fixtures.cjs");

const cfg = policy.readConfig({
  ...vars,
  FACTORY_AUTOMATION_ENABLED: "true",
  FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
  FACTORY_GITHUB_APP_SLUG: "factory-example",
});
const run = { ...context, workflowRef: contract.WORKFLOW, workflowSha: base, event: "schedule" };
const pr = {
  number: 52,
  state: "open",
  draft: false,
  user: { login: "dependabot[bot]", type: "Bot", id: 49699333 },
  head: {
    sha: "b".repeat(40),
    ref: "dependabot/npm_and_yarn/foo-2.0.0",
    repo: { full_name: policy.REPOSITORY },
  },
  base: { ref: "main", sha: base, repo: { full_name: policy.REPOSITORY } },
};
const request = { package: { name: "foo", version: "2.0.0" }, reason: "native_ci_failure" };
const claim = () => dep.claimDependency(policy.emptyState(policy.REPOSITORY), pr, run, cfg);
const reserve = (state, config = cfg) =>
  dep.reserveDependencyCompatibility(state, pr.number, run, config, request);
const proof = (grantId) => ({ grantId, originalHead: pr.head.sha, head: "c".repeat(40), base });
const modelContext = {
  ...run,
  ticket: pr.number,
  phase: "code",
  slot: "dependency_compat",
  head: pr.head.sha,
};

test("compatibility reserves one coding session on the original native dependency PR", () => {
  const { state, grant } = reserve(claim());
  assert.equal(state.tickets[52].pr, pr.number);
  assert.equal(state.tickets[52].coding, 1);
  assert.equal(state.tickets[52].aiSessionLimit, cfg.aiSessions);
  assert.equal(state.active.ticket, pr.number);
  assert.equal(policy.preflight(state, grant.id, modelContext, cfg).id, grant.id);
  assert.throws(() => policy.preflight(state, grant.id, { ...modelContext, slot: "cycle1" }, cfg));
  assert.throws(() => reserve(state), /unfinished|already/i);
  assert.throws(() => reserve(claim(), { ...cfg, aiSessions: 1 }), /budget/i);

  const tampered = structuredClone(state);
  tampered.tickets[52].dependency.attempts[0].compatibility.grantId = "1".repeat(36);
  assert.throws(() => policy.validateState(tampered), /compatibility/i);
});

test("publish intent binds the original and candidate head, preserving provenance on success", () => {
  const { state, grant } = reserve(claim());
  assert.throws(
    () => dep.recordDependencyCompatibility(state, 52, run, cfg, proof(grant.id)),
    /intent/i
  );
  const intent = dep.beginDependencyCompatibilityPublish(state, 52, run, cfg, proof(grant.id));
  assert.throws(() => policy.preflight(intent, grant.id, modelContext, cfg), /publish/i);
  assert.throws(
    () =>
      dep.recordDependencyCompatibility(intent, 52, run, cfg, {
        ...proof(grant.id),
        head: "d".repeat(40),
      }),
    /intent/i
  );
  const next = dep.recordDependencyCompatibility(intent, 52, run, cfg, proof(grant.id));
  const t = next.tickets[52];
  assert.equal(t.coding, 1);
  assert.equal(t.status, "awaiting_review");
  assert.equal(t.pr, pr.number);
  assert.equal(t.head, proof(grant.id).head);
  assert.equal(next.grants[grant.id].head, pr.head.sha);
  assert.equal(next.grants[grant.id].outcome, "awaiting_review");
  assert.equal(datesMatch(t.dependency.attempts), true);
  assert.equal(next.active.ticket, pr.number);
  assert.throws(() => dep.reserveDependencyReview(next, run, cfg), /analysis/i);
  assert.doesNotThrow(() => policy.validateState(next));
});

function datesMatch(attempts) {
  return attempts[0].compatibility.publish.confirmedAt === attempts[1].at;
}

test("a prior review counts against the shared coding and review budget", () => {
  const prior = claim();
  const id = "7366f29e-4936-4aae-b83f-c2fc379d95cf";
  prior.tickets[52].reviews = 1;
  prior.grants[id] = {
    id,
    ticket: 52,
    phase: "review",
    slot: "dependency",
    head: pr.head.sha,
    runId: run.runId,
    runAttempt: run.runAttempt,
    status: "finished",
    outcome: "blocked",
  };
  assert.throws(() => reserve(prior, { ...cfg, aiSessions: 2 }), /budget/i);
  assert.equal(reserve(prior, { ...cfg, aiSessions: 3 }).state.tickets[52].reviews, 1);
});

test("a terminal publication intent resumes from the observed commit or releases the slot", () => {
  const { state, grant } = reserve(claim());
  const evidence = proof(grant.id);
  const successor = { ...run, runId: "101" };
  const intent = dep.beginDependencyCompatibilityPublish(state, 52, run, cfg, evidence);
  assert.throws(
    () =>
      dep.reconcileDependencyCompatibility(intent, 52, successor, cfg, {
        ...evidence,
        outcome: "published",
        observedHead: pr.head.sha,
        observedBase: base,
      }),
    /observed/i
  );
  const recovered = dep.reconcileDependencyCompatibility(intent, 52, successor, cfg, {
    ...evidence,
    outcome: "published",
    observedHead: evidence.head,
    observedBase: base,
  });
  assert.equal(recovered.active.runId, successor.runId);
  assert.equal(recovered.tickets[52].coding, 1);
  assert.equal(recovered.tickets[52].head, evidence.head);
  assert.equal(dep.unresolvedCompatibilityPublish(recovered.tickets[52]), undefined);
  const unsent = dep.reconcileDependencyCompatibility(intent, 52, successor, cfg, {
    ...evidence,
    outcome: "not_published",
    observedHead: pr.head.sha,
    observedBase: base,
  });
  assert.equal(unsent.active, null);
  assert.equal(unsent.tickets[52].coding, 1);
  assert.equal(unsent.grants[grant.id].outcome, "blocked");
  assert.equal(
    unsent.tickets[52].dependency.attempts[0].compatibility.publish.outcome,
    "not_published"
  );
  assert.equal(dep.canClaimCompatibility(unsent.tickets[52], pr, cfg), false);
});

test("stop rejects publication and retains intent for model-free recovery after resume", () => {
  const { state, grant } = reserve(claim());
  const evidence = proof(grant.id);
  const intent = dep.beginDependencyCompatibilityPublish(state, 52, run, cfg, evidence);
  const stopped = policy.finish(intent, grant.id, { status: "blocked" });
  stopped.stop = {
    actor: "haideearus",
    at: new Date().toISOString(),
    id: "d37da1cf-ee68-4ffb-9e42-60407256af8b",
    previous: {
      FACTORY_ENABLED: "true",
      FACTORY_AUTOMATION_ENABLED: "true",
      FACTORY_AUTOMERGE_ENABLED: "false",
    },
    reason: "Owner emergency stop",
  };
  const next = { ...run, runId: "101" };
  const observed = {
    ...evidence,
    outcome: "published",
    observedHead: evidence.head,
    observedBase: base,
  };
  assert.throws(() => dep.recordDependencyCompatibility(stopped, 52, run, cfg, evidence), /stop/i);
  assert.throws(
    () => dep.reconcileDependencyCompatibility(stopped, 52, next, cfg, observed),
    /stop/i
  );
  const resumed = dep.reconcileDependencyCompatibility(
    { ...stopped, stop: null },
    52,
    next,
    cfg,
    observed
  );
  assert.equal(resumed.tickets[52].head, evidence.head);
  assert.equal(resumed.grants[grant.id].outcome, "blocked");
  assert.equal(resumed.tickets[52].coding, 1);
});

test("only a requested refresh can carry compatibility provenance onto a new main base", () => {
  const { state, grant } = reserve(claim());
  const evidence = proof(grant.id);
  const intent = dep.beginDependencyCompatibilityPublish(state, 52, run, cfg, evidence);
  const confirmed = dep.recordDependencyCompatibility(intent, 52, run, cfg, evidence);
  const released = dep.finishPreparation(confirmed, 52, run);
  const successor = { ...run, runId: "101" };
  const refresh = { head: evidence.head, base: "d".repeat(40) };
  const fresh = {
    ...pr,
    head: { ...pr.head, sha: "f".repeat(40) },
    base: { ...pr.base, sha: refresh.base },
  };
  const admit = (s) =>
    dep.claimDependency(s, fresh, successor, cfg, new Date(), undefined, {
      refreshReceipt: { originalHead: evidence.head, head: fresh.head.sha, base: refresh.base },
    });
  assert.throws(() => admit(released), /durable intent/i);
  const requested = dep.beginDependencyCompatibilityRefresh(released, 52, successor, cfg, refresh);
  assert.equal(
    dep.compatibilityRefreshRequested(requested.tickets[52], refresh.head, refresh.base),
    true
  );
  assert.throws(
    () => dep.beginDependencyCompatibilityRefresh(requested, 52, successor, cfg, refresh),
    /already requested/i
  );
  const resumed = admit(requested);
  assert.equal(resumed.tickets[52].coding, 1);
  assert.equal(resumed.tickets[52].head, fresh.head.sha);
  assert.equal(resumed.tickets[52].dependency.attempts.at(-1).base, refresh.base);
  assert.equal(contract.compatibilityForHead(resumed.tickets[52]).head, pr.head.sha);
});

test("only saved failed CI on a repaired exact head can admit another bounded coding attempt", () => {
  const { state, grant } = reserve(claim());
  const evidence = proof(grant.id);
  const intent = dep.beginDependencyCompatibilityPublish(state, 52, run, cfg, evidence);
  const confirmed = dep.recordDependencyCompatibility(intent, 52, run, cfg, evidence);
  const updated = { ...pr, head: { ...pr.head, sha: evidence.head } };
  const held = dep.finishPreparation(confirmed, 52, run);
  assert.equal(dep.canClaimCompatibility(held.tickets[52], updated, cfg), false);
  assert.equal(dep.canResumeCompatibility(held.tickets[52], updated, cfg), true);
  held.tickets[52].ci = {
    head: updated.head.sha,
    requestId: "17abfed5-4eae-4b95-af34-b07573754bb0",
    runId: 123,
    passed: false,
  };
  const successor = { ...run, runId: "101" };
  assert.equal(dep.canResumeCompatibility(held.tickets[52], updated, cfg), false);
  assert.equal(dep.canClaimCompatibility(held.tickets[52], updated, cfg), true);
  assert.equal(dep.canClaimCompatibility(held.tickets[52], updated, { ...cfg, retries: 0 }), false);
  const claimed = dep.claimDependency(held, updated, successor, cfg, new Date(), undefined, {
    compatibility: true,
  });
  const next = dep.reserveDependencyCompatibility(claimed, 52, successor, cfg, request).state;
  assert.equal(next.tickets[52].coding, 2);
  assert.equal(next.tickets[52].retries, 1);
  assert.equal(next.grants[grant.id].outcome, "awaiting_review");
});

test("a legacy blocked head can use compatibility once and spends no extra daily admission", () => {
  const original = claim();
  original.tickets[52].ci = {
    head: pr.head.sha,
    requestId: "17abfed5-4eae-4b95-af34-b07573754bb0",
    runId: 123,
    passed: false,
  };
  const old = dep.finishPreparation(original, pr.number, run);
  const successor = { ...run, runId: "102" };
  assert.equal(dep.canClaimCompatibility(old.tickets[52], pr, cfg), true);
  const next = dep.claimDependency(old, pr, successor, cfg, new Date(), undefined, {
    compatibility: true,
  });
  assert.equal(next.tickets[52].coding, 0);
  assert.deepEqual(next.tickets[52].dependency.attempts[0], {
    ...old.tickets[52].dependency.attempts[0],
    ci: original.tickets[52].ci,
  });
  assert.equal(next.tickets[52].ci, null);
  assert.equal(Object.values(next.days).flat().length, 1);
  const held = dep.finishPreparation(next, pr.number, successor);
  assert.equal(dep.canClaimCompatibility(held.tickets[52], pr, cfg), false);
  assert.throws(
    () =>
      dep.claimDependency(held, pr, { ...run, runId: "103" }, cfg, new Date(), undefined, {
        compatibility: true,
      }),
    /already attempted/i
  );
});

function finishBlockingReview(state) {
  const t = state.tickets[52];
  const attempt = t.dependency.attempts.at(-1);
  const id = "7366f29e-4936-4aae-b83f-c2fc379d95cf";
  t.ci = {
    head: t.head,
    requestId: "17abfed5-4eae-4b95-af34-b07573754bb0",
    runId: 123,
    passed: true,
  };
  attempt.evidence = [
    { at: attempt.at, finishedAt: attempt.at, status: "ready", digest: "a".repeat(64) },
  ];
  t.status = "reviewing";
  t.reviews = 1;
  state.grants[id] = {
    id,
    ticket: 52,
    phase: "review",
    slot: "dependency",
    head: t.head,
    runId: attempt.runId,
    runAttempt: attempt.runAttempt,
    status: "reserved",
    at: attempt.at,
  };
  const blocked = policy.finish(state, id, { status: "blocked" });
  const feedback = {
    head: t.head,
    verdict: "changes_requested",
    summary:
      "The new package version changes the authentication callback signature and the application depends on the legacy argument order.",
    findings: [
      {
        severity: "important",
        message:
          "Update the authentication callback call site and cover its argument order in the regression suite.",
      },
    ],
  };
  blocked.tickets[52].feedback = JSON.stringify(feedback);
  return { blocked, feedback, id };
}

test("a genuine independent blocking verdict is archived for only one exact-head correction", () => {
  const { blocked, feedback, id } = finishBlockingReview(claim());
  const grants = Object.values(blocked.grants);
  const successor = { ...run, runId: "101" };
  const adopt = (s) =>
    dep.claimDependency(s, pr, successor, cfg, new Date(), undefined, {
      compatibility: true,
    });
  assert.equal(dep.canClaimCompatibility(blocked.tickets[52], pr, cfg, grants), true);
  for (const invalid of [
    null,
    { ...feedback, findings: [] },
    { ...feedback, verdict: "pass", findings: [] },
  ]) {
    const corrupted = structuredClone(blocked);
    corrupted.tickets[52].feedback = JSON.stringify(invalid);
    assert.equal(dep.canClaimCompatibility(corrupted.tickets[52], pr, cfg, grants), false);
    assert.throws(() => adopt(corrupted), /already attempted/i);
  }
  const adopted = adopt(blocked);
  assert.deepEqual(contract.archivedCompatibilityReview(adopted.tickets[52]), {
    grantId: id,
    result: feedback,
  });
  assert.equal(adopted.tickets[52].ci, null);
  assert.equal(adopted.tickets[52].reviews, 1);
  const r = dep.reserveDependencyCompatibility(adopted, 52, successor, cfg, {
    ...request,
    reason: "review_blocked",
  });
  assert.equal(r.state.tickets[52].coding, 1);
  assert.equal(r.state.tickets[52].reviews, 1);
  const held = policy.finish(r.state, r.grant.id, { status: "blocked" });
  assert.equal(
    dep.canClaimCompatibility(held.tickets[52], pr, cfg, Object.values(held.grants)),
    false
  );
});

test("a model-free continuation does not consume the later exact-head coding reclaim", () => {
  const { state, grant } = reserve(claim());
  const evidence = proof(grant.id);
  const intent = dep.beginDependencyCompatibilityPublish(state, 52, run, cfg, evidence);
  const confirmed = dep.recordDependencyCompatibility(intent, 52, run, cfg, evidence);
  const held = dep.finishPreparation(confirmed, 52, run);
  const updated = { ...pr, head: { ...pr.head, sha: evidence.head } };
  const resumed = dep.claimDependency(
    held,
    updated,
    { ...run, runId: "101" },
    cfg,
    new Date(),
    undefined,
    {
      continuation: true,
    }
  );
  const { blocked, feedback } = finishBlockingReview(resumed);
  const resumedAgain = dep.claimDependency(
    blocked,
    updated,
    { ...run, runId: "102" },
    cfg,
    new Date(),
    undefined,
    {
      compatibility: true,
    }
  );
  assert.equal(resumedAgain.tickets[52].coding, 1);
  assert.equal(resumedAgain.tickets[52].reviews, 1);
  assert.deepEqual(contract.archivedCompatibilityReview(resumedAgain.tickets[52]).result, feedback);
});
