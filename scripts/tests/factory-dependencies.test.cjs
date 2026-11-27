const { test } = require("node:test");
const assert = require("node:assert/strict");
const { GitHub, Ledger, ROOT } = require("../factory/github.cjs");
const policy = require("../factory/policy.cjs");
const { DependencyCoordinator, DependencyMerger } = require("../factory/dependencies.cjs");
const { GitHubFixture, vars, context, head } = require("./helpers/factory-fixtures.cjs");
const d = require("../factory/dependency-contract.cjs");
const { reportFor, toolDigest } = require("../factory/dependency-analysis.cjs");
const ctx = { ...context, workflowRef: d.WORKFLOW, workflowSha: head, event: "schedule" };
const cfg = policy.readConfig({
  ...vars,
  FACTORY_AUTOMATION_ENABLED: "true",
  FACTORY_AUTOMERGE_ENABLED: "true",
  FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
  FACTORY_GITHUB_APP_SLUG: "factory-example",
});

test("dependency refusal logs explain a known stale base without exposing arbitrary errors", () => {
  const { refusalReason } = require("../factory/dependency-run.cjs");
  assert.match(
    refusalReason(Error("Dependency PR requires a current-main rebase")),
    /requires a current-main rebase/
  );
  assert.match(
    refusalReason(Error("Native review gate is pending or unavailable")),
    /Native review gate is pending/
  );
  assert.doesNotMatch(refusalReason(Error("private response body")), /private response body/);
});
function pr() {
  return {
    number: 52,
    state: "open",
    draft: false,
    user: { login: "dependabot[bot]", type: "Bot", id: 49699333 },
    head: {
      sha: "b".repeat(40),
      ref: "dependabot/npm_and_yarn/foo-1.0.1",
      repo: { full_name: policy.REPOSITORY },
    },
    base: { ref: "main", sha: head, repo: { full_name: policy.REPOSITORY } },
  };
}
async function fixture(config = cfg) {
  const f = new GitHubFixture(),
    original = f.fetch;
  f.rows = [pr()];
  f.modelJobs = 0;
  f.checks = [];
  f.publicationStates = [];
  f.fetch = async (url, options = {}) => {
    const u = new URL(url),
      p = u.pathname.slice(ROOT.length),
      method = options.method || "GET";
    const response = (data) => new Response(JSON.stringify(data));
    const extra = f.route?.(p, method, options.body && JSON.parse(options.body), u);
    if (extra !== undefined) return response(extra);
    if (method === "POST" && p === "/check-runs") {
      const check = JSON.parse(options.body);
      f.publicationStates.push(await ledger.read());
      if (f.failPublication) return new Response("{}", { status: 503 });
      f.checks.push(check);
      return response({ id: f.checks.length, ...check });
    }
    if (method === "GET" && p === "/pulls") return response(f.rows);
    if (method === "GET" && p === "/pulls/52") return response(f.rows[0]);
    if (method === "GET" && p === "/pulls/52/files")
      return response(
        f.files || [
          { filename: "package.json", status: "modified" },
          { filename: "yarn.lock", status: "modified" },
        ]
      );
    if (method === "GET" && p === "/git/ref/heads/main") return response({ object: { sha: head } });
    if (method === "GET" && p.startsWith("/compare/"))
      return response({ behind_by: 0, merge_base_commit: { sha: head } });
    if (method === "GET" && ["/actions/runs/100", "/actions/runs/100/attempts/1"].includes(p))
      return response({
        id: 100,
        path: ".github/workflows/factory-dependencies.yml",
        repository: { full_name: policy.REPOSITORY },
        head_repository: { full_name: policy.REPOSITORY },
        head_sha: head,
        head_branch: "main",
        event: "schedule",
        actor: { login: "haideearus" },
        triggering_actor: { login: "haideearus" },
        run_attempt: 1,
        status: f.terminal ? "completed" : "in_progress",
      });
    if (method === "GET" && p === "/actions/runs/100/jobs")
      return response({
        jobs: [
          {
            id: 7,
            run_id: 100,
            name: f.stage || "analysis",
            status: "completed",
            conclusion: f.producerFailure ? "failure" : "success",
          },
        ],
      });
    if (method === "GET" && p === "/actions/runs/100/artifacts")
      return response({
        artifacts: [
          {
            id: 8,
            name: "dependency-" + (f.stage || "analysis") + "-100-1-52-" + "b".repeat(40),
            expired: false,
            size_in_bytes: 500,
            workflow_run: { id: 100, head_sha: head },
          },
        ],
      });
    return original(url, options);
  };
  const api = new GitHub({ token: "fixture", fetch: f.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  return { f, api, ledger, coordinator: new DependencyCoordinator(api, config, ctx) };
}
test("disabled and dry-run dependency selection never mutate the ledger or reserve inference", async () => {
  const x = await fixture({ ...cfg, enabled: false });
  const before = (await x.ledger.read()).commit;
  assert.equal((await x.coordinator.select(false)).ready, false);
  assert.equal((await x.coordinator.select(true)).ticket, 52);
  assert.equal((await x.ledger.read()).commit, before);
});
test("stale genuine dependency proposals produce a typed refresh hold, never an idle claim or grant", async () => {
  const x = await fixture();
  x.f.route = (path) =>
    path.startsWith("/compare/")
      ? { behind_by: 1, merge_base_commit: { sha: "f".repeat(40) } }
      : undefined;
  const before = (await x.ledger.read()).state,
    result = await x.coordinator.select(false);
  assert.equal(result.ready, false);
  assert.equal(result.ticket, 52);
  assert.equal(result.holds[0].code, "requires-current-main-rebase");
  assert.match(result.reason, /refresh/i);
  assert.deepEqual((await x.ledger.read()).state, before);
});
test("genuine dependency intake reserves metadata only and forged authors are ignored", async () => {
  const x = await fixture();
  const picked = await x.coordinator.select(false);
  assert.equal(picked.ticket, 52);
  assert.equal(picked.mode, "review");
  const state = (await x.ledger.read()).state;
  assert.equal(state.tickets["52"].reviews, 0);
  assert.equal(Object.keys(state.grants).length, 0);
  const y = await fixture();
  y.f.rows[0].user.login = "attacker";
  assert.equal((await y.coordinator.select(true)).ready, false);
});
test("foreign producer and wrong-head report cannot authorize dependency analysis", async () => {
  const x = await fixture();
  await x.coordinator.select(false);
  const identity = {
    repository: policy.REPOSITORY,
    pr: 52,
    base: head,
    head: "b".repeat(40),
    workflowSha: head,
    runId: "100",
    runAttempt: 1,
    stage: "analysis",
    toolDigest: toolDigest(),
  };
  const report = reportFor(identity, {
    changed: 2,
    candidateVersions: 1,
    cleared: [],
    remainingBaseline: [],
  });
  await assert.rejects(x.coordinator.acceptAnalysis(52, { ...report, head: "c".repeat(40) }));
  x.f.producerFailure = true;
  await assert.rejects(x.coordinator.acceptAnalysis(52, report), /producer/i);
  x.f.producerFailure = false;
  await x.coordinator.acceptAnalysis(52, report);
  assert.equal((await x.ledger.read()).state.tickets["52"].analysis.head, "b".repeat(40));
});
test("terminal metadata-only preparation can be finalized without resetting its admission", async () => {
  const x = await fixture();
  await x.coordinator.select(false);
  x.f.terminal = true;
  const later = new DependencyCoordinator(x.api, cfg, { ...ctx, runId: "101" });
  await later.select(false);
  const s = (await x.ledger.read()).state;
  assert.equal(s.active, null);
  assert.equal(s.tickets["52"].status, "blocked");
  assert.equal(Object.values(s.days).flat().length, 1);
});
test("a refreshed PR can recover an old terminal bot preparation using its bound receipt", async (t) => {
  const x = await fixture();
  await x.coordinator.select(false);
  const oldHead = x.f.rows[0].head.sha;
  x.f.rows[0].head.sha = "c".repeat(40);
  const bot = { login: "github-actions[bot]", id: 41898282 };
  x.f.route = (path) =>
    path === "/actions/runs/100/attempts/1"
      ? {
          id: 100,
          path: ".github/workflows/factory-dependencies.yml",
          repository: { full_name: policy.REPOSITORY },
          head_repository: { full_name: policy.REPOSITORY },
          head_sha: head,
          head_branch: "main",
          event: "workflow_dispatch",
          actor: bot,
          triggering_actor: bot,
          run_attempt: 1,
          status: "completed",
        }
      : undefined;
  const trusted = require("../factory/trusted-wake.cjs");
  const verify = t.mock.method(trusted, "verifyPreparationOrigin", async (_api, run, ticket, a) => {
    assert.equal(run.id, 100);
    assert.equal(ticket.pr, 52);
    assert.equal(a.head, oldHead);
    return true;
  });
  const later = new DependencyCoordinator(x.api, cfg, { ...ctx, runId: "101" });
  assert.equal((await later.select(false)).head, x.f.rows[0].head.sha);
  assert.equal(verify.mock.callCount(), 1);
  const state = (await x.ledger.read()).state;
  assert.deepEqual(
    state.tickets[52].dependency.attempts.map((attempt) => attempt.head),
    [oldHead, x.f.rows[0].head.sha]
  );
  assert.equal(Object.keys(state.grants).length, 0);
});
test("dependency merge cannot use ordinary owner context or bypass its dedicated provenance", async () => {
  const x = await fixture();
  const merger = new DependencyMerger(x.api, cfg, context, null);
  await assert.rejects(merger.merge(52), /context|Unauthorized/i);
});

const report = (stage = "analysis", now = new Date(), runId = "100") =>
  reportFor(
    {
      repository: policy.REPOSITORY,
      pr: 52,
      base: head,
      head: pr().head.sha,
      workflowSha: head,
      runId,
      runAttempt: 1,
      stage,
      toolDigest: toolDigest(),
    },
    { changed: 2, candidateVersions: 1, cleared: [], remainingBaseline: [] },
    now
  );
async function reviewSession(x) {
  x.f.route = (p) =>
    p === "/actions/runs/9"
      ? {
          id: 9,
          head_sha: pr().head.sha,
          display_title: "Factory CI / 11111111-1111-4111-8111-111111111111",
          event: "workflow_dispatch",
          path: ".github/workflows/factory-ci.yml",
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
        }
      : p === "/actions/runs/9/jobs"
        ? { jobs: [{ name: "verify", status: "completed", conclusion: "success" }] }
        : undefined;
  await x.coordinator.select(false);
  await x.coordinator.acceptAnalysis(52, report());
  await x.ledger.update((s) => {
    s.tickets["52"].ci = {
      head: pr().head.sha,
      passed: true,
      runId: 9,
      requestId: "11111111-1111-4111-8111-111111111111",
    };
    return { state: s };
  });
  const packet = {
    version: 2,
    base: pr().base.sha,
    head: pr().head.sha,
    checkedAt: new Date().toISOString(),
    ciEvidence: { status: "verified", runId: 9, runAttempt: 1, head: pr().head.sha },
  };
  await assert.rejects(x.coordinator.reserve(52, packet), /evidence/);
  await x.ledger.update((state) => {
    state.tickets["52"].dependency.attempts[0].evidence = [
      {
        at: packet.checkedAt,
        finishedAt: packet.checkedAt,
        status: "ready",
        digest: require("../factory/dependency-contract.cjs").digest(packet),
      },
    ];
    return { state };
  });
  await assert.rejects(x.coordinator.reserve(52, { ...packet, injected: true }), /evidence/);
  const g = await x.coordinator.reserve(52, packet);
  return {
    grantId: g.grantId,
    bundle: {
      kind: "review",
      grantId: g.grantId,
      base: pr().head.sha,
      result: {
        head: pr().head.sha,
        verdict: "pass",
        summary:
          "Reviewed package.json and yarn.lock against the dependency criteria; supplied CI and current registry and advisory facts support this head, with compatibility limits recorded.",
        findings: [],
      },
    },
  };
}
async function reviewed(x) {
  const { grantId, bundle } = await reviewSession(x);
  await x.coordinator.assess(52, grantId, bundle);
}

async function reviewedV2() {
  const config = { ...cfg, concurrent: 2, daily: 20 };
  const x = await fixture(config);
  await x.ledger.update((state) => {
    state.version = 2;
    delete state.active;
    state.activeTickets = {};
    return { state };
  });
  await reviewed(x);
  x.config = config;
  return x;
}
test("v2 fallback never selects another merge parent while reviewed owner is live", async () => {
  const x = await reviewedV2();
  const before = await x.ledger.read();
  const observer = new DependencyCoordinator(x.api, x.config, { ...ctx, runId: "200" });
  const result = await observer.select(false);
  assert.equal(result.ready, false);
  assert.deepEqual(await x.ledger.read(), before);
});
test("v2 terminal reviewed dependency retires stale proof and reclaims only its slot", async () => {
  const x = await reviewedV2();
  x.f.terminal = true;
  x.f.rows[0].head.sha = "c".repeat(40);
  const before = (await x.ledger.read()).state;
  const observer = new DependencyCoordinator(x.api, x.config, { ...ctx, runId: "200" });
  const result = await observer.select(false);
  assert.equal(result.mode, "review");
  const after = (await x.ledger.read()).state;
  assert.equal(after.activeTickets[52].runId, "200");
  assert.deepEqual(after.days, before.days);
  assert.deepEqual(after.grants, before.grants);
  assert.equal(after.tickets[52].reviews, before.tickets[52].reviews);
  assert.equal(after.tickets[52].approval, null);
  assert.equal(after.tickets[52].dependency.attempts.length, 2);
});
test("global app intent is routed before a different reviewed dependency", async () => {
  const x = await reviewedV2();
  x.f.terminal = true;
  const appContext = {
    ...context,
    runId: "200",
    workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
    workflowSha: head,
    event: "schedule",
  };
  await x.ledger.update((state) => {
    const coding = policy.reserve(state, appContext, x.config);
    coding.state.tickets[10].automatic = {
      workflowRef: appContext.workflowRef,
      workflowSha: head,
      runId: "200",
      runAttempt: 1,
      appSlug: x.config.appSlug,
    };
    let next = policy.finish(coding.state, coding.grant.id, { status: "awaiting_review", pr: 30 });
    const review = policy.reserve(next, { ...appContext, phase: "review" }, x.config);
    next = policy.finish(review.state, review.grant.id, {
      status: "reviewed",
      verdict: "pass",
      pr: 30,
      head,
      evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/200`,
    });
    next.tickets[10].merge = {
      status: "intent",
      head,
      pr: 30,
      at: new Date().toISOString(),
      runId: "200",
      runAttempt: 1,
    };
    return { state: next };
  });
  const before = await x.ledger.read();
  const { AutomaticCoordinator } = require("../factory/automation.cjs");
  const prior = x.f.route;
  x.f.route = (p, ...args) =>
    p === "/actions/runs/200/attempts/1"
      ? { id: 200, run_attempt: 1, status: "completed" }
      : prior(p, ...args);
  const app = new AutomaticCoordinator(x.api, x.config, { ...appContext, runId: "201" });
  const result = await app.pick();
  assert.equal(result.kind, "merge");
  assert.equal(result.ticket, 10);
  assert.equal((await x.coordinator.select(false)).ready, false);
  assert.deepEqual(await x.ledger.read(), before);
});

test("dependency assessment refreshes evidence only after committing genuine review proof", async () => {
  const x = await fixture();
  const { grantId, bundle } = await reviewSession(x);
  const before = (await x.ledger.read()).state;
  const result = await x.coordinator.assess(52, grantId, bundle);
  assert.equal(result.reviewed, true);
  assert.equal(x.f.checks.length, 1);
  assert.equal(x.f.checks[0].name, "Factory review evidence");
  assert.equal(x.f.checks[0].head_sha, pr().head.sha);
  assert.equal(x.f.checks[0].conclusion, "success");
  const published = x.f.publicationStates[0];
  const after = await x.ledger.read();
  assert.deepEqual(after, published, "publication must not write the ledger");
  assert.equal(policy.reviewGate(published.state, { number: 52, head: pr().head.sha }).ok, true);
  assert.deepEqual(after.state.days, before.days);
  for (const key of ["reviews", "coding", "retries"])
    assert.equal(after.state.tickets["52"][key], before.tickets["52"][key]);
});

test("changes-requested dependency assessment refreshes failure without granting approval", async () => {
  const x = await fixture();
  const { grantId, bundle } = await reviewSession(x);
  bundle.result.verdict = "changes_requested";
  const result = await x.coordinator.assess(52, grantId, bundle);
  assert.equal(result.reviewed, false);
  assert.equal(x.f.checks.length, 1);
  assert.equal(x.f.checks[0].conclusion, "failure");
  const { state } = await x.ledger.read();
  assert.equal(state.tickets["52"].status, "blocked");
  assert.equal(state.tickets["52"].approval, null);
  assert.equal(state.tickets["52"].reviews, 1);
});

test("invalid dependency review cannot publish a check or finish its grant", async () => {
  const x = await fixture();
  const { grantId, bundle } = await reviewSession(x);
  const before = await x.ledger.read();
  bundle.result.findings = [
    {
      severity: "important",
      message:
        "package.json retains a vulnerable dependency version; this update must be held until the affected range is cleared.",
    },
  ];
  await assert.rejects(x.coordinator.assess(52, grantId, bundle), /blocking findings/);
  assert.deepEqual(await x.ledger.read(), before);
  assert.equal(x.f.publicationStates.length, 0);
});

test("changed dependency head cannot borrow the previous head's assessment success", async () => {
  const x = await fixture();
  const { grantId, bundle } = await reviewSession(x);
  const gate = x.coordinator.controller.gate.bind(x.coordinator.controller);
  x.coordinator.controller.gate = async (number) => {
    x.f.rows[0].head.sha = "c".repeat(40);
    return gate(number);
  };
  const result = await x.coordinator.assess(52, grantId, bundle);
  assert.equal(result.reviewed, false);
  assert.equal(x.f.checks.length, 1);
  assert.equal(x.f.checks[0].head_sha, "c".repeat(40));
  assert.equal(x.f.checks[0].conclusion, "failure");
  const { state } = await x.ledger.read();
  assert.equal(state.tickets["52"].approval.head, pr().head.sha);
  assert.equal(state.tickets["52"].reviews, 1);
});

test("unavailable proof after assessment publishes failure without discarding the review", async () => {
  const x = await fixture();
  const { grantId, bundle } = await reviewSession(x);
  x.coordinator.controller.ledger = {
    read: async () => {
      throw new Error("Fixture unavailable");
    },
  };
  const result = await x.coordinator.assess(52, grantId, bundle);
  assert.equal(result.reviewed, false);
  assert.equal(x.f.checks[0].conclusion, "failure");
  const committed = await x.ledger.read();
  assert.equal(committed.state.tickets["52"].status, "reviewed");
  assert.equal(committed.state.tickets["52"].reviews, 1);
  assert.deepEqual(committed, x.f.publicationStates[0]);
});

test("failed status publication retains finished review and permits metadata-only recovery", async () => {
  const x = await fixture();
  const { grantId, bundle } = await reviewSession(x);
  x.f.failPublication = true;
  await assert.rejects(x.coordinator.assess(52, grantId, bundle), /503/);
  assert.equal(x.f.publicationStates.length, 1);
  const committed = await x.ledger.read();
  assert.equal(committed.state.tickets["52"].status, "reviewed");
  assert.equal(committed.state.tickets["52"].reviews, 1);
  assert.equal(committed.state.grants[grantId].status, "finished");
  x.f.failPublication = false;
  assert.equal((await x.coordinator.controller.gate(52)).ok, true);
  assert.deepEqual(await x.ledger.read(), committed);
  assert.equal(x.f.checks[0].conclusion, "success");
});
async function protectedMergeFixture() {
  const x = await fixture();
  await reviewed(x);
  x.f.stage = "premerge";
  x.f.rows[0].mergeable = true;
  x.f.rows[0].mergeable_state = "clean";
  const prior = x.f.route,
    sha = pr().head.sha;
  const assoc = {
    number: 52,
    url: `https://api.github.com${ROOT}/pulls/52`,
    head: { sha, ref: pr().head.ref, repo: { url: `https://api.github.com${ROOT}` } },
    base: { ref: "main", repo: { url: `https://api.github.com${ROOT}` } },
  };
  const checks = ["verify", "Factory review gate"].map((name, i) => ({
    id: 201 + i,
    name,
    head_sha: sha,
    app: { id: 15368 },
    check_suite: { id: 301 + i },
    pull_requests: [assoc],
    details_url: `https://github.com/${policy.REPOSITORY}/actions/runs/${401 + i}/job/${501 + i}`,
    status: "completed",
    conclusion: "success",
  }));
  x.f.route = (p, method, body) => {
    if (p === `/commits/${sha}/check-runs`) return { check_runs: checks };
    for (let i = 0; i < 2; i++) {
      if (p === `/actions/runs/${401 + i}`)
        return {
          id: 401 + i,
          path: `.github/workflows/${i ? "factory-review-status.yml" : "factory-ci.yml"}`,
          event: "pull_request",
          head_sha: sha,
          head_branch: pr().head.ref,
          repository: { full_name: policy.REPOSITORY },
          head_repository: { full_name: policy.REPOSITORY },
          check_suite_id: 301 + i,
          pull_requests: [assoc],
          status: "completed",
          conclusion: "success",
        };
      if (p === `/actions/runs/${401 + i}/jobs`)
        return {
          jobs: [
            {
              id: 501 + i,
              run_id: 401 + i,
              name: checks[i].name,
              check_run_url: `https://api.github.com${ROOT}/check-runs/${201 + i}`,
              status: "completed",
              conclusion: "success",
            },
          ],
        };
    }
    if (p === "/pulls/52/merge" && method === "PUT") {
      assert.equal(body.sha, sha);
      x.f.puts = (x.f.puts || 0) + 1;
      Object.assign(x.f.rows[0], {
        state: "closed",
        merged: true,
        merge_commit_sha: "d".repeat(40),
      });
      return { merged: true, sha: "d".repeat(40) };
    }
    return prior(p);
  };
  return x;
}

test("analysis, CI, one readonly review and native protected merge complete without a coding grant", async () => {
  const x = await protectedMergeFixture();
  const merged = await new DependencyMerger(x.api, cfg, ctx, report("premerge")).merge(52);
  assert.equal(merged.merged, true);
  assert.equal(x.f.puts, 1);
  const s = (await x.ledger.read()).state;
  assert.equal(s.active, null);
  assert.equal(s.tickets["52"].coding, 0);
  assert.equal(s.tickets["52"].reviews, 1);
  assert.equal(s.tickets["52"].merge.status, "merged");
});

function failFinalCheck(x, runContext, error) {
  const merger = new DependencyMerger(
    x.api,
    cfg,
    runContext,
    report("premerge", new Date(), runContext.runId)
  );
  const checks = merger.checks.bind(merger);
  let reads = 0;
  merger.checks = (...args) => {
    if (++reads === 2) throw error;
    return checks(...args);
  };
  return merger.merge(52);
}

function retryProducer(x) {
  const prior = x.f.route;
  x.f.route = (p, ...args) => {
    if (p === "/actions/runs/101")
      return {
        id: 101,
        path: ".github/workflows/factory-dependencies.yml",
        repository: { full_name: policy.REPOSITORY },
        head_repository: { full_name: policy.REPOSITORY },
        head_sha: head,
        head_branch: "main",
        event: "schedule",
        actor: { login: policy.OWNER },
        triggering_actor: { login: policy.OWNER },
        run_attempt: 1,
        status: "in_progress",
      };
    if (p === "/actions/runs/101/jobs")
      return {
        jobs: [{ name: "premerge", run_id: 101, status: "completed", conclusion: "success" }],
      };
    if (p === "/actions/runs/101/artifacts")
      return {
        artifacts: [
          {
            id: 24,
            name: `dependency-premerge-101-1-52-${pr().head.sha}`,
            expired: false,
            size_in_bytes: 500,
            workflow_run: { id: 101, head_sha: head },
          },
        ],
      };
    return prior(p, ...args);
  };
}

test("a confirmed unsent GitHub read failure claims one delayed merge-only retry and retains its approval", async () => {
  const x = await protectedMergeFixture();
  const original = (await x.ledger.read()).state;
  const error = Object.assign(Error("GitHub request failed (503)"), { status: 503, method: "GET" });
  await assert.rejects(failFinalCheck(x, ctx, error), /503/);
  const first = (await x.ledger.read()).state;
  const t = first.tickets["52"];
  assert.equal(t.dependencyMergeRetry.phase, "queued");
  assert.equal(t.dependencyMergeRetry.failure.stage, "required-checks");
  assert.equal(first.active, null);
  assert.equal(t.merge, undefined);
  assert.deepEqual(t.approval, original.tickets["52"].approval);
  assert.deepEqual(t.ci, original.tickets["52"].ci);
  assert.deepEqual(first.grants, original.grants);
  const laterContext = { ...ctx, runId: "101" };
  const later = new DependencyCoordinator(x.api, cfg, laterContext);
  assert.equal((await later.select(false, new Date(t.dependencyMergeRetry.at))).ready, false);

  const due = new Date(t.dependencyMergeRetry.retryAt);
  const picks = await Promise.all([later.select(false, due), later.select(false, due)]);
  assert.equal(picks.filter((p) => p.ready).length, 1);
  assert.equal(picks.find((p) => p.ready).mode, "merge");
  retryProducer(x);
  await assert.rejects(failFinalCheck(x, laterContext, error), /503/);
  const exhausted = (await x.ledger.read()).state;
  assert.equal(exhausted.tickets["52"].dependencyMergeRetry.phase, "held");
  assert.equal(exhausted.active, null);
  assert.deepEqual(exhausted.grants, original.grants);
  assert.equal(x.f.puts || 0, 0);
  assert.equal((await later.select(false, due)).ready, false);
  const admission = require("../factory/dependency-policy.cjs");
  const other = pr();
  other.number = 53;
  assert.equal(
    admission.claimDependency(exhausted, other, { ...ctx, runId: "102" }, cfg).active.ticket,
    53
  );
});

test("a claimed retry can merge with the same CI and review after all checks pass", async () => {
  const x = await protectedMergeFixture();
  const error = Object.assign(Error("GitHub request failed (503)"), { status: 503, method: "GET" });
  await assert.rejects(failFinalCheck(x, ctx, error), /503/);
  const before = (await x.ledger.read()).state;
  const due = new Date(before.tickets["52"].dependencyMergeRetry.retryAt);
  const run = { ...ctx, runId: "101" };
  const coordinator = new DependencyCoordinator(x.api, cfg, run);
  assert.equal((await coordinator.select(false, due)).mode, "merge");
  retryProducer(x);
  const result = await new DependencyMerger(
    x.api,
    cfg,
    run,
    report("premerge", new Date(), run.runId)
  ).merge(52);
  assert.equal(result.merged, true);
  assert.equal(x.f.puts, 1);
  const after = (await x.ledger.read()).state;
  assert.deepEqual(after.grants, before.grants);
  assert.deepEqual(after.tickets["52"].ci, before.tickets["52"].ci);
  assert.equal(after.tickets["52"].merge.status, "merged");
});

test("#299 regression: a legacy gate hold can claim one merge-only attempt with the saved review", async () => {
  const x = await protectedMergeFixture();
  await assert.rejects(
    failFinalCheck(x, ctx, Error("Refreshed native review gate did not pass")),
    /Refreshed native review gate/
  );
  const original = (await x.ledger.read()).state;
  const held = original.tickets["52"].dependencyMergeRetry;
  assert.equal(held.phase, "held");
  assert.equal(held.retryAt, null);
  const later = new DependencyCoordinator(x.api, cfg, { ...ctx, runId: "101" });
  const time = new Date(Date.parse(held.at) + 1_000);
  const results = await Promise.all([later.select(false, time), later.select(false, time)]);
  assert.equal(results.filter((result) => result.ready && result.mode === "merge").length, 1);
  const claimed = (await x.ledger.read()).state;
  assert.equal(claimed.active.ticket, 52);
  assert.equal(claimed.active.runId, "101");
  assert.deepEqual(claimed.grants, original.grants);
  assert.deepEqual(claimed.days, original.days);
  assert.deepEqual(claimed.tickets["52"].approval, original.tickets["52"].approval);
  assert.deepEqual(claimed.tickets["52"].ci, original.tickets["52"].ci);
  await later.finalize(52);
  const completed = (await x.ledger.read()).state;
  assert.equal(completed.active, null);
  assert.equal(completed.tickets["52"].dependencyMergeRetry.phase, "held");
  assert.equal((await later.select(false, time)).ready, false);
});

test("a held legacy gate without valid saved review does not starve the next dependency", async () => {
  const x = await protectedMergeFixture();
  await assert.rejects(failFinalCheck(x, ctx, Error("Refreshed native review gate did not pass")));
  await x.ledger.update((state) => {
    state.tickets["52"].feedback = "Archived text without review proof";
    return { state };
  });
  const next = pr();
  next.number = 53;
  next.head = { ...next.head, ref: "dependabot/npm_and_yarn/bar-1.0.1", sha: "e".repeat(40) };
  x.f.rows.push(next);
  const route = x.f.route;
  x.f.route = (path, ...args) => {
    if (path === "/pulls/53") return next;
    if (path === "/pulls/53/files") return [{ filename: "yarn.lock", status: "modified" }];
    return route(path, ...args);
  };
  const later = new DependencyCoordinator(x.api, cfg, { ...ctx, runId: "101" });
  const selected = await later.select(false);
  assert.equal(selected.ready, true);
  assert.equal(selected.ticket, 53);
  const final = (await x.ledger.read()).state;
  assert.equal(final.tickets["52"].dependencyMergeRetry.phase, "held");
  assert.equal(final.active.ticket, 53);
});

test("#299 regression: an already reviewed dependency waits for a fresh native gate and merges once", async () => {
  const x = await protectedMergeFixture();
  await assert.rejects(failFinalCheck(x, ctx, Error("Refreshed native review gate did not pass")));
  const saved = (await x.ledger.read()).state;
  const held = saved.tickets["52"].dependencyMergeRetry;
  const context = { ...ctx, runId: "101" };
  const retry = new DependencyCoordinator(x.api, cfg, context);
  assert.equal((await retry.select(false, new Date(Date.parse(held.at) + 1_000))).mode, "merge");
  retryProducer(x);
  const route = x.f.route;
  const sha = pr().head.sha;
  const originalChecks = route(`/commits/${sha}/check-runs`, "GET").check_runs;
  const originalGate = route("/actions/runs/402", "GET");
  const originalJob = route("/actions/runs/402/jobs", "GET").jobs[0];
  let labelled = false;
  let labelRequests = 0;
  x.f.rows[0].mergeable_state = "blocked";
  x.f.route = (path, method, ...args) => {
    if (path === `/commits/${sha}/check-runs`) {
      const gates = [{ ...originalChecks[1], conclusion: "failure" }];
      if (labelled)
        gates.push({
          ...originalChecks[1],
          id: 203,
          check_suite: { id: 303 },
          details_url: `https://github.com/${policy.REPOSITORY}/actions/runs/403/job/503`,
        });
      return { check_runs: [originalChecks[0], ...gates] };
    }
    if (path === "/actions/runs/402")
      return { ...originalGate, run_attempt: 1, conclusion: "failure" };
    if (path === "/actions/runs/402/jobs")
      return {
        jobs: [
          {
            ...originalJob,
            conclusion: "failure",
            steps: [
              { name: "Verify current-head independent proof without a model or state write" },
            ],
          },
        ],
      };
    if (path === "/actions/runs/403")
      return { ...originalGate, id: 403, check_suite_id: 303, run_attempt: 1 };
    if (path === "/actions/runs/403/jobs" || path === "/actions/runs/403/attempts/1/jobs")
      return {
        jobs: [
          {
            ...originalJob,
            id: 503,
            run_id: 403,
            head_sha: sha,
            run_attempt: 1,
            check_run_url: `https://api.github.com${ROOT}/check-runs/203`,
            steps: [
              { name: "Verify exact-head review with current trusted main", conclusion: "success" },
            ],
          },
        ],
      };
    if (path === "/labels/factory-gate-refresh") return { name: "factory-gate-refresh" };
    if (path === "/issues/52/labels" && method === "POST") {
      labelRequests++;
      labelled = true;
      x.f.rows[0].mergeable_state = "clean";
      return [{ name: "factory-gate-refresh" }];
    }
    if (path === "/pulls/52/merge" && method === "PUT") assert.ok(labelled);
    return route(path, method, ...args);
  };
  const result = await new DependencyMerger(
    x.api,
    cfg,
    context,
    report("premerge", new Date(), "101"),
    {
      sleep: async () => {},
    }
  ).merge(52);
  assert.equal(result.merged, true);
  assert.equal(labelRequests, 1);
  assert.equal(x.f.puts, 1);
  const complete = (await x.ledger.read()).state;
  assert.equal(complete.active, null);
  assert.equal(complete.tickets["52"].merge.status, "merged");
  assert.deepEqual(complete.grants, saved.grants);
  assert.deepEqual(complete.days, saved.days);
  assert.deepEqual(complete.tickets["52"].approval, saved.tickets["52"].approval);
});

test("a final check identity failure holds only its PR and provides a safe diagnostic", async () => {
  const x = await protectedMergeFixture();
  const error = Error("Missing native required check: verify");
  await assert.rejects(failFinalCheck(x, ctx, error), (reported) => {
    const { refusalReason } = require("../factory/dependency-run.cjs");
    assert.match(
      refusalReason(reported),
      /required.checks.*Missing native required check: verify/i
    );
    return true;
  });
  const state = (await x.ledger.read()).state;
  assert.equal(state.tickets["52"].dependencyMergeRetry.phase, "held");
  assert.equal(state.tickets["52"].approval.verdict, "pass");
  assert.equal(x.f.puts || 0, 0);
});

test("a verified GitHub read failure in the initial merge checks also schedules a safe retry", async () => {
  const x = await protectedMergeFixture();
  const merger = new DependencyMerger(x.api, cfg, ctx, report("premerge"));
  merger.checks = async () => {
    throw Object.assign(Error("GitHub request failed (502)"), { status: 502, method: "GET" });
  };
  await assert.rejects(merger.merge(52), /502/);
  const s = (await x.ledger.read()).state;
  assert.equal(s.tickets["52"].dependencyMergeRetry.phase, "queued");
  assert.equal(s.tickets["52"].merge, undefined);
  assert.equal(s.tickets["52"].reviews, 1);
  assert.equal(x.f.puts || 0, 0);
});

test("a retry that ends in premerge releases its queue hold without a new review", async () => {
  const x = await protectedMergeFixture();
  const failure = Object.assign(Error("GitHub request failed (503)"), {
    status: 503,
    method: "GET",
  });
  await assert.rejects(failFinalCheck(x, ctx, failure), /503/);
  const queued = (await x.ledger.read()).state.tickets["52"].dependencyMergeRetry;
  const later = new DependencyCoordinator(x.api, cfg, { ...ctx, runId: "101" });
  const due = new Date(queued.retryAt);
  assert.equal((await later.select(false, due)).ready, true);
  await later.finalize(52);
  const s = (await x.ledger.read()).state;
  assert.equal(s.tickets["52"].dependencyMergeRetry.phase, "held");
  assert.equal(s.tickets["52"].approval.verdict, "pass");
  assert.equal(s.tickets["52"].reviews, 1);
  assert.equal(s.tickets["52"].merge, undefined);
  assert.equal((await later.select(false, due)).ready, false);
});

test("a matching failed premerge report transfers an authenticated read failure to the retry ledger", async () => {
  const x = await protectedMergeFixture();
  const retry = require("../factory/dependency-merge-retry.cjs");
  const error = Object.assign(Error("GitHub request failed (503)"), { status: 503, method: "GET" });
  const premergeEvidence = JSON.stringify(retry.premergeEvidence(error));
  const outcome = { premergeFailed: true, premergeEvidence, head: "c".repeat(40) };
  await x.coordinator.finalize(52, outcome);
  assert.equal((await x.ledger.read()).state.tickets["52"].dependencyMergeRetry, undefined);
  await x.coordinator.finalize(52, { ...outcome, head: pr().head.sha });
  const t = (await x.ledger.read()).state.tickets["52"];
  assert.equal(t.dependencyMergeRetry.phase, "queued");
  assert.deepEqual(t.dependencyMergeRetry.failure, {
    stage: "premerge",
    reason: "GitHub read failed (503)",
  });
  assert.equal(t.approval.verdict, "pass");
});

test("a quota retry waits for an authenticated reset and permission denials do not retry", () => {
  const { premergeEvidence } = require("../factory/dependency-merge-retry.cjs");
  const now = new Date("2026-11-25T12:00:00.000Z");
  const denied = Object.assign(Error("GitHub request failed (403)"), {
    status: 403,
    method: "GET",
  });
  assert.equal(premergeEvidence(denied, now).retryAt, null);
  denied.quotaResetAt = +now + 20 * 60_000;
  assert.equal(premergeEvidence(denied, now).retryAt, "2026-11-25T12:20:00.000Z");
  denied.method = "PUT";
  assert.equal(premergeEvidence(denied, now).retryAt, null);
});

test("an uncertain send during a claimed retry keeps its intent through finalization", async () => {
  const x = await protectedMergeFixture();
  const failure = Object.assign(Error("GitHub request failed (503)"), {
    status: 503,
    method: "GET",
  });
  await assert.rejects(failFinalCheck(x, ctx, failure), /503/);
  const queued = (await x.ledger.read()).state.tickets["52"].dependencyMergeRetry;
  const run = { ...ctx, runId: "101" };
  const later = new DependencyCoordinator(x.api, cfg, run);
  const due = new Date(queued.retryAt);
  await later.select(false, due);
  retryProducer(x);
  const previous = x.f.route;
  x.f.route = (p, method, ...args) => {
    if (p === "/pulls/52/merge" && method === "PUT") {
      x.f.puts = (x.f.puts || 0) + 1;
      throw Error("fixture transport lost the response");
    }
    return previous(p, method, ...args);
  };
  const merger = new DependencyMerger(x.api, cfg, run, report("premerge", new Date(), "101"), {
    sleep: async () => {},
    maxPolls: 1,
  });
  assert.equal((await merger.merge(52)).pending, true);
  const before = await x.ledger.read();
  await later.finalize(52);
  assert.deepEqual(await x.ledger.read(), before);
  assert.equal(before.state.tickets["52"].merge.status, "intent");
  assert.equal(x.f.puts, 1);

  const retry = require("../factory/dependency-merge-retry.cjs");
  assert.equal(retry.permits(before.state.tickets["52"], run, new Date(+due + 26 * 60_000)), false);
});

test("dependency confirmation tolerates advanced main while matching PR closure is delayed", async () => {
  const x = await protectedMergeFixture();
  const before = structuredClone((await x.ledger.read()).state);
  const prior = x.f.route;
  let sent = false;
  let reads = 0;
  x.f.route = (p, method, body) => {
    if (p === "/pulls/52/merge" && method === "PUT") {
      x.f.puts = (x.f.puts || 0) + 1;
      sent = true;
      return { merged: true, sha: "d".repeat(40) };
    }
    if (sent && p === "/git/ref/heads/main") return { object: { sha: "d".repeat(40) } };
    if (sent && p === "/pulls/52" && method === "GET" && ++reads === 2)
      Object.assign(x.f.rows[0], {
        state: "closed",
        merged: true,
        merge_commit_sha: "d".repeat(40),
      });
    return prior(p, method, body);
  };
  const result = await new DependencyMerger(x.api, cfg, ctx, report("premerge"), {
    sleep: async () => {},
    maxPolls: 2,
  }).merge(52);
  assert.equal(result.merged, true);
  assert.equal(x.f.puts, 1);
  const after = (await x.ledger.read()).state;
  assert.deepEqual(after.tickets["52"].approval, before.tickets["52"].approval);
  assert.deepEqual(after.grants, before.grants);
  assert.deepEqual(after.days, before.days);
});

for (const secondRead of ["stale-open", "unavailable"])
  test(`dependency terminal revalidation retries ${secondRead} metadata within its observation budget`, async () => {
    const x = await fixture();
    await reviewed(x);
    await retainIntent(x);
    x.f.terminal = true;
    const prior = x.f.route;
    let reads = 0;
    x.f.route = (p, ...args) => {
      if (p === "/git/ref/heads/main") return { object: { sha: "d".repeat(40) } };
      if (p === "/pulls/52") {
        reads++;
        if (reads === 2) {
          if (secondRead === "unavailable") throw new Error("temporary private network message");
          return pr();
        }
        return { ...pr(), state: "closed", merged: true, merge_commit_sha: "d".repeat(40) };
      }
      return prior(p, ...args);
    };
    const result = await new DependencyMerger(x.api, cfg, ctx, null, {
      sleep: async () => {},
      maxPolls: 2,
    }).merge(52);
    assert.equal(result.merged, true);
    assert.equal(x.f.puts || 0, 0);
    assert.equal((await x.ledger.read()).state.tickets["52"].reviews, 1);
  });

async function retainIntent(x) {
  await x.ledger.update((s) => {
    s.tickets["52"].merge = {
      status: "intent",
      head: pr().head.sha,
      pr: 52,
      runId: "100",
      runAttempt: 1,
      at: "2026-11-16T10:00:00.000Z",
    };
    s.active = { ticket: 52, runId: "100", runAttempt: 1 };
    return { state: s };
  });
}

test("pending dependency intent routes directly to observation after main advanced", async () => {
  const x = await fixture();
  await reviewed(x);
  await retainIntent(x);
  x.f.terminal = true;
  const before = await x.ledger.read();
  const prior = x.f.route;
  x.f.route = (p, ...args) =>
    p === "/git/ref/heads/main" ? { object: { sha: "d".repeat(40) } } : prior(p, ...args);
  const picked = await x.coordinator.select(false);
  assert.equal(picked.mode, "reconcile");
  assert.equal((await x.ledger.read()).commit, before.commit);
  const next = new DependencyMerger(x.api, cfg, { ...ctx, runId: "101" }, null, {
    sleep: async () => {},
    maxPolls: 2,
  });
  const result = await next.merge(52);
  assert.equal(result.pending, true);
  assert.equal(result.reason, "merge_confirmation_pending");
  assert.equal(x.f.puts || 0, 0);
  assert.deepEqual((await x.ledger.read()).state, before.state);
});

test("the observation path cannot authorize a fresh dependency merge on an outdated main", async () => {
  const x = await protectedMergeFixture();
  const before = await x.ledger.read();
  const prior = x.f.route;
  x.f.route = (p, ...args) =>
    p === "/git/ref/heads/main" ? { object: { sha: "d".repeat(40) } } : prior(p, ...args);
  await assert.rejects(
    new DependencyMerger(x.api, cfg, ctx, report("premerge")).merge(52),
    /rebase/i
  );
  assert.equal(x.f.puts || 0, 0);
  assert.equal((await x.ledger.read()).commit, before.commit);
});

test("a changed head after an uncertain dependency PUT preserves approval for owner reconciliation", async () => {
  const x = await fixture();
  await reviewed(x);
  await retainIntent(x);
  const before = await x.ledger.read();
  x.f.rows[0].head.sha = "c".repeat(40);
  const picked = await x.coordinator.select(false);
  assert.equal(picked.ready, false);
  assert.match(picked.reason, /owner reconciliation/i);
  assert.equal((await x.ledger.read()).commit, before.commit);
  assert.deepEqual((await x.ledger.read()).state, before.state);
});
test("pending dependency merge blocks app admission and closed history reconciles without inference", async () => {
  const x = await fixture();
  await reviewed(x);
  const { AutomaticCoordinator } = require("../factory/automation.cjs");
  const app = new AutomaticCoordinator(x.api, cfg, {
    ...ctx,
    workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
  });
  assert.equal((await app.pick()).ticket, undefined);
  Object.assign(x.f.rows[0], { state: "closed", merged: true, merge_commit_sha: "d".repeat(40) });
  assert.equal((await x.coordinator.select(false)).mode, "reconcile");
  const result = await new DependencyMerger(x.api, cfg, ctx, null).merge(52);
  assert.equal(result.merged, true);
  assert.equal((await x.ledger.read()).state.tickets["52"].reviews, 1);
});
test("a bot rebase retires stale approval and admits a bounded new head without resetting history", async () => {
  const x = await fixture();
  await reviewed(x);
  x.f.rows[0].head.sha = "c".repeat(40);
  const before = (await x.ledger.read()).commit;
  const preview = await x.coordinator.select(true);
  assert.equal(preview.ready, false);
  assert.equal((await x.ledger.read()).commit, before);
  const picked = await x.coordinator.select(false);
  assert.equal(picked.mode, "review");
  assert.equal(picked.head, "c".repeat(40));
  const s = (await x.ledger.read()).state,
    t = s.tickets["52"];
  assert.equal(t.reviews, 1);
  assert.equal(t.approval, null);
  assert.equal(t.dependency.attempts.length, 2);
  assert.equal(Object.values(s.days).flat().length, 1);
  assert.equal(Object.values(s.grants).length, 1);
});
test("a recorded historical attempt is used to release orphan metadata after a rerun", async () => {
  const x = await fixture();
  await x.coordinator.select(false);
  const historical = {
    id: 100,
    path: ".github/workflows/factory-dependencies.yml",
    repository: { full_name: policy.REPOSITORY },
    head_repository: { full_name: policy.REPOSITORY },
    head_sha: head,
    head_branch: "main",
    event: "schedule",
    actor: { login: "haideearus" },
    triggering_actor: { login: "haideearus" },
    run_attempt: 1,
    status: "completed",
  };
  let historicalReads = 0;
  x.f.route = (p) =>
    p === "/actions/runs/100"
      ? { ...historical, run_attempt: 2 }
      : p === "/actions/runs/100/attempts/1"
        ? (historicalReads++, historical)
        : undefined;
  await new DependencyCoordinator(x.api, cfg, { ...ctx, runId: "101" }).select(false);
  const s = (await x.ledger.read()).state;
  assert.ok(historicalReads > 0);
  assert.equal(s.active, null);
  assert.equal(s.tickets["52"].status, "blocked");
  assert.equal(s.tickets["52"].reviews, 0);
  assert.equal(Object.values(s.days).flat().length, 1);
});
test("a bot head change cannot release an uncertain intent even when its owning run is terminal", async () => {
  const x = await fixture();
  await reviewed(x);
  await x.ledger.update((s) => {
    const t = s.tickets["52"];
    t.merge = {
      status: "intent",
      head: t.head,
      pr: 52,
      at: new Date().toISOString(),
      runId: "100",
      runAttempt: 1,
    };
    s.active = { ticket: 52, runId: "100", runAttempt: 1 };
    return { state: s };
  });
  x.f.rows[0].head.sha = "c".repeat(40);
  const prior = x.f.route;
  x.f.route = (p) =>
    p === "/actions/runs/100/attempts/1"
      ? {
          id: 100,
          path: ".github/workflows/factory-dependencies.yml",
          head_sha: head,
          head_branch: "main",
          repository: { full_name: policy.REPOSITORY },
          head_repository: { full_name: policy.REPOSITORY },
          actor: { login: "haideearus" },
          triggering_actor: { login: "haideearus" },
          event: "schedule",
          run_attempt: 1,
          status: x.f.intentTerminal ? "completed" : "in_progress",
        }
      : prior(p);
  assert.equal((await x.coordinator.select(false)).ready, false);
  assert.equal((await x.ledger.read()).state.tickets["52"].merge.status, "intent");
  const before = await x.ledger.read();
  x.f.intentTerminal = true;
  assert.equal((await x.coordinator.select(false)).ready, false);
  assert.deepEqual((await x.ledger.read()).state, before.state);
});
test("old premerge reports and changed dependency paths never reach a merge write", async () => {
  const x = await fixture();
  await reviewed(x);
  x.f.stage = "premerge";
  await assert.rejects(
    new DependencyMerger(x.api, cfg, ctx, report("premerge", new Date(Date.now() - 360000))).merge(
      52
    ),
    /stale|time/i
  );
  x.f.files = [{ filename: ".github/workflows/injected.yml", status: "modified" }];
  await assert.rejects(
    new DependencyMerger(x.api, cfg, ctx, report("premerge")).merge(52),
    /forbidden/i
  );
  assert.equal(x.f.puts, undefined);
});
test("analysis reads immutable package files and consumes OSV before authorizing review", async () => {
  const x = await fixture();
  await x.coordinator.select(false);
  const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const manifest = JSON.stringify({ name: "demo", dependencies: { foo: "^1.0.0" } });
  x.f.route = (p, _m, _b, u) => {
    if (!["/contents/package.json", "/contents/yarn.lock"].includes(p)) return undefined;
    const name = p.slice(10),
      ref = u.searchParams.get("ref");
    assert.ok([head, pr().head.sha].includes(ref));
    const version = ref === head ? "1.0.0" : "1.0.1";
    const text =
      name === "package.json"
        ? manifest
        : `"foo@^1.0.0":\n  version "${version}"\n  resolved "https://registry.npmjs.org/foo/-/foo-${version}.tgz"\n  integrity ${integrity}\n`;
    return {
      type: "file",
      path: name,
      size: Buffer.byteLength(text),
      encoding: "base64",
      content: Buffer.from(text).toString("base64"),
    };
  };
  const { analyze } = require("../factory/dependency-run.cjs");
  let calls = 0;
  const r = await analyze(x.coordinator, 52, "analysis", {
    transport: async (_u, options) => {
      calls++;
      assert.deepEqual(
        JSON.parse(options.body).queries.map((q) => q.version),
        ["1.0.0", "1.0.1"]
      );
      return new Response(JSON.stringify({ results: [{}, {}] }));
    },
  });
  assert.equal(r.result.changed, 2);
  assert.equal(calls, 1);
  await assert.rejects(
    analyze(x.coordinator, 52, "analysis", {
      transport: async () => new Response("", { status: 503 }),
    }),
    /OSV/
  );
  assert.equal(Object.keys((await x.ledger.read()).state.grants).length, 0);
});

test("workflow preserves preview, trusted source, readonly model and isolated credentials", () => {
  const fs = require("node:fs"),
    path = require("node:path"),
    yaml = require("js-yaml");
  const file = (name) =>
    yaml.load(fs.readFileSync(path.resolve(__dirname, "../../.github/" + name), "utf8"));
  const w = file("workflows/factory-dependencies.yml");
  assert.equal(w.on.workflow_dispatch.inputs.preview.default, true);
  assert.match(w.jobs.preview.if, /workflow_dispatch.*&& inputs.preview/);
  assert.match(w.jobs.select.if, /github\.event_name == 'workflow_dispatch' && !inputs\.preview/);
  assert.deepEqual(w.jobs.preview.permissions, {
    contents: "read",
    issues: "read",
    "pull-requests": "read",
    actions: "read",
  });
  assert.equal(w.jobs.select.permissions.issues, "write");
  assert.ok(w.jobs.preview.steps.some((step) => step.with?.operation === "dep_track"));
  const track = w.jobs.select.steps.find((step) => step.env?.FACTORY_OPERATION === "dep_track");
  assert.equal(track.run, "node scripts/factory/dependency-run.cjs");
  assert.equal(
    track.env.FACTORY_DEPENDABOT_REBASE_TOKEN,
    "${{ secrets.FACTORY_DEPENDABOT_REBASE_TOKEN }}"
  );
  assert.doesNotMatch(JSON.stringify(w.jobs.select.steps.filter((s) => s !== track)), /secrets\./);
  const afterMerge = w.jobs.track_after_merge;
  assert.deepEqual(afterMerge.needs, ["select", "merge", "finalize"]);
  assert.match(afterMerge.if, /always\(\).*needs\.merge\.outputs\.merged == 'true'/);
  assert.equal(afterMerge.concurrency.group, "factory-ledger");
  assert.deepEqual(afterMerge.permissions, w.jobs.select.permissions);
  assert.deepEqual(afterMerge.steps.at(-1).env, {
    ...track.env,
    FACTORY_OPERATION: "dep_recover_tracked",
  });
  assert.doesNotMatch(JSON.stringify(afterMerge), /CLAUDE|APP_PRIVATE_KEY/);
  for (const [name, job] of Object.entries(w.jobs)) {
    if (name !== "preview" && name !== "finalize") {
      assert.match(job.if, /FACTORY_ENABLED/);
      assert.match(job.if, /FACTORY_AUTOMATION_ENABLED/);
    }
    for (const step of job.steps || [])
      if (step.uses?.startsWith("actions/checkout@"))
        assert.equal(step.with.ref, "${{ github.workflow_sha }}");
  }
  for (const name of [
    "analysis",
    "premerge",
    "ci",
    "preview",
    "evidence",
    "reserve",
    "assess",
    "finalize",
  ])
    assert.doesNotMatch(JSON.stringify(w.jobs[name]), /secrets\./);
  assert.equal(w.jobs.review.with.phase, "review");
  assert.equal(w.jobs.review.with.slot, "dependency");
  assert.deepEqual(w.jobs.assess.permissions, {
    contents: "write",
    issues: "read",
    "pull-requests": "read",
    actions: "read",
    checks: "write",
  });
  assert.deepEqual(w.jobs.review.permissions, {
    actions: "read",
    contents: "read",
    issues: "read",
    "pull-requests": "read",
  });
  assert.deepEqual(w.permissions, { contents: "read" });
  for (const [name, job] of Object.entries(w.jobs))
    if (name !== "assess") assert.notEqual(job.permissions?.checks, "write");
  assert.deepEqual(Object.keys(w.jobs.review.secrets), ["CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.match(w.jobs.merge.if, /FACTORY_AUTOMERGE_ENABLED/);
  assert.ok(
    require("../factory/stop.cjs").AGENT_WORKFLOWS.includes(
      ".github/workflows/factory-dependencies.yml"
    )
  );
  const dep = file("dependabot.yml").updates;
  assert.equal(dep.length, 1);
  assert.equal(dep[0].directory, "/");
  assert.equal(dep[0]["open-pull-requests-limit"], 1);
  assert.equal(dep[0].schedule.timezone, "Europe/Bucharest");
  assert.equal(dep[0].ignore[0]["update-types"][0], "version-update:semver-major");
  const tools = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../factory/dependency-tools/package-lock.json"))
  );
  assert.deepEqual(Object.keys(tools.packages).sort(), [
    "",
    "node_modules/@yarnpkg/lockfile",
    "node_modules/semver",
  ]);
});
test("placeholder dependency review leaves the used reservation and gate untouched", async () => {
  const x = await fixture(),
    { grantId, bundle } = await reviewSession(x),
    before = await x.ledger.read();
  bundle.result.summary = "test";
  bundle.result.findings = [{ severity: "minor", message: "test" }];
  await assert.rejects(x.coordinator.assess(52, grantId, bundle), /review|placeholder/i);
  assert.deepEqual(await x.ledger.read(), before);
  assert.equal(x.f.publicationStates.length, 0);
});

test("a stale reviewed native head releases its terminal lease without using a new review", async () => {
  const x = await reviewedV2();
  const before = (await x.ledger.read()).state;
  const route = x.f.route;
  x.f.rows[0].base.sha = "e".repeat(40);
  x.f.route = (p, ...args) =>
    p === "/git/ref/heads/main"
      ? { object: { sha: x.f.rows[0].base.sha } }
      : p.startsWith("/compare/")
        ? { behind_by: 1, merge_base_commit: { sha: head } }
        : route(p, ...args);
  const observer = new DependencyCoordinator(x.api, x.config, { ...ctx, runId: "200" });
  assert.equal((await observer.select(false)).ready, false);
  assert.deepEqual((await x.ledger.read()).state, before);
  x.f.terminal = true;
  assert.equal((await observer.select(false)).ready, false);
  const after = (await x.ledger.read()).state;
  assert.equal(after.tickets["52"].status, "blocked");
  assert.equal(after.tickets["52"].approval, null);
  assert.deepEqual(after.activeTickets, {});
  assert.deepEqual(after.days, before.days);
  assert.deepEqual(after.grants, before.grants);
  assert.deepEqual(
    after.tickets["52"].dependency.attempts,
    before.tickets["52"].dependency.attempts
  );
  assert.equal(after.tickets["52"].reviews, before.tickets["52"].reviews);
});
