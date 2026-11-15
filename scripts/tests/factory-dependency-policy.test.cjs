const { test } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const dep = require("../factory/dependency-policy.cjs");
const contract = require("../factory/dependency-contract.cjs");
const { vars, context, head } = require("./helpers/factory-fixtures.cjs");
const cfg = policy.readConfig({
  ...vars,
  FACTORY_MAX_REVIEWS_PER_TICKET: "10",
  FACTORY_AUTOMATION_ENABLED: "true",
  FACTORY_AUTOMERGE_ENABLED: "true",
  FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
  FACTORY_GITHUB_APP_SLUG: "factory-example",
});
const ctx = { ...context, workflowRef: contract.WORKFLOW, workflowSha: head, event: "schedule" };
const pr = (sha = "b".repeat(40)) => ({
  number: 52,
  state: "open",
  draft: false,
  user: { login: "dependabot[bot]", type: "Bot", id: 49699333 },
  head: { sha, ref: "dependabot/npm_and_yarn/foo-1.0.1", repo: { full_name: policy.REPOSITORY } },
  base: { ref: "main", sha: head, repo: { full_name: policy.REPOSITORY } },
});
test("dependency claim shares one admission and lock, without pretending a model ran", () => {
  const s = dep.claimDependency(policy.emptyState(policy.REPOSITORY), pr(), ctx, cfg);
  assert.equal(s.tickets["52"].coding, 0);
  assert.equal(s.tickets["52"].reviews, 0);
  assert.equal(Object.keys(s.grants).length, 0);
  assert.equal(s.active.ticket, 52);
  assert.equal(Object.values(s.days).flat().length, 1);
  policy.validateState(s);
  assert.throws(() => policy.reserve(s, { ...context, ticket: 12 }, cfg), /active/i);
});
test("review cannot reserve before successful analysis and CI", () => {
  const s = dep.claimDependency(policy.emptyState(policy.REPOSITORY), pr(), ctx, cfg);
  assert.throws(() => dep.reserveDependencyReview(s, ctx, cfg), /analysis|CI/i);
  s.tickets["52"].analysis = { head: pr().head.sha };
  s.tickets["52"].ci = { head: pr().head.sha, passed: true, runId: 9 };
  assert.throws(() => dep.reserveDependencyReview(s, ctx, cfg), /report|analysis/i);
  const a = require("../factory/dependency-analysis.cjs");
  s.tickets["52"].analysis = a.reportFor(
    {
      repository: policy.REPOSITORY,
      pr: 52,
      base: head,
      head: pr().head.sha,
      workflowSha: head,
      runId: ctx.runId,
      runAttempt: 1,
      stage: "analysis",
      toolDigest: a.toolDigest(),
    },
    { changed: 2, fixed: [] }
  );
  const r = dep.reserveDependencyReview(s, ctx, cfg);
  assert.equal(r.state.tickets["52"].reviews, 1);
  assert.equal(r.grant.phase, "review");
  assert.equal(r.grant.slot, "dependency");
  assert.equal(
    policy.preflight(
      r.state,
      r.grant.id,
      { ...ctx, ticket: 52, head: pr().head.sha, slot: "dependency", phase: "review" },
      cfg
    ).id,
    r.grant.id
  );
});
test("ordinary workflows and coding grants cannot consume dependency provenance", () => {
  const s = dep.claimDependency(policy.emptyState(policy.REPOSITORY), pr(), ctx, cfg);
  assert.throws(() =>
    policy.reserve(
      s,
      { ...ctx, ticket: 52, head: pr().head.sha, origin: "dependency-pr", phase: "code" },
      cfg
    )
  );
  assert.throws(() =>
    dep.claimDependency(policy.emptyState(policy.REPOSITORY), pr(), context, cfg)
  );
  assert.throws(() =>
    dep.claimDependency(
      policy.emptyState(policy.REPOSITORY),
      { ...pr(), user: { login: "someone", type: "Bot", id: 49699333 } },
      ctx,
      cfg
    )
  );
});
test("failed preparation consumes admission, not review; same head never loops", () => {
  const s = dep.claimDependency(policy.emptyState(policy.REPOSITORY), pr(), ctx, cfg);
  const next = dep.finishPreparation(s, 52, ctx);
  assert.equal(next.active, null);
  assert.equal(next.tickets["52"].status, "blocked");
  assert.equal(next.tickets["52"].reviews, 0);
  assert.equal(Object.values(next.days).flat().length, 1);
  assert.throws(
    () => dep.claimDependency(next, pr(), { ...ctx, runId: "101" }, cfg),
    /head|attempt/i
  );
  const again = dep.claimDependency(next, pr("c".repeat(40)), { ...ctx, runId: "101" }, cfg);
  assert.equal(Object.values(again.days).flat().length, 1);
  assert.equal(again.tickets["52"].dependency.attempts.length, 2);
});
test("disabled, stopped, daily exhaustion and pending merges prevent metadata admissions", () => {
  assert.throws(
    () =>
      dep.claimDependency(policy.emptyState(policy.REPOSITORY), pr(), ctx, {
        ...cfg,
        enabled: false,
      }),
    /disabled/i
  );
  assert.throws(
    () =>
      dep.claimDependency(policy.emptyState(policy.REPOSITORY), pr(), ctx, { ...cfg, daily: 0 }),
    /limit/i
  );
});
test("dependency head attempts have a lifetime bound even before inference", () => {
  let s = policy.emptyState(policy.REPOSITORY);
  for (let i = 0; i < 10; i++) {
    const c = { ...ctx, runId: String(100 + i) };
    s = dep.claimDependency(s, pr(String(i).repeat(40)), c, cfg);
    s = dep.finishPreparation(s, 52, c);
  }
  assert.throws(
    () => dep.claimDependency(s, pr("f".repeat(40)), { ...ctx, runId: "200" }, cfg),
    /limit/i
  );
});
module.exports = { pr, ctx, cfg };
