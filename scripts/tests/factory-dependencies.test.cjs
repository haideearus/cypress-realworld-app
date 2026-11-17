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
test("dependency merge cannot use ordinary owner context or bypass its dedicated provenance", async () => {
  const x = await fixture();
  const merger = new DependencyMerger(x.api, cfg, context, null);
  await assert.rejects(merger.merge(52), /context|Unauthorized/i);
});

const report = (stage = "analysis", now = new Date()) =>
  reportFor(
    {
      repository: policy.REPOSITORY,
      pr: 52,
      base: head,
      head: pr().head.sha,
      workflowSha: head,
      runId: "100",
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
  const g = await x.coordinator.reserve(52);
  return {
    grantId: g.grantId,
    bundle: {
      kind: "review",
      grantId: g.grantId,
      base: pr().head.sha,
      result: {
        head: pr().head.sha,
        verdict: "pass",
        summary: "Independent fixture review",
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
  bundle.result.findings = [{ severity: "important", message: "Blocking fixture finding" }];
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
  assert.match(w.jobs.select.if, /inputs.preview/);
  for (const [name, job] of Object.entries(w.jobs)) {
    if (name !== "select" && name !== "finalize") {
      assert.match(job.if, /FACTORY_ENABLED/);
      assert.match(job.if, /FACTORY_AUTOMATION_ENABLED/);
    }
    for (const step of job.steps || [])
      if (step.uses?.startsWith("actions/checkout@"))
        assert.equal(step.with.ref, "${{ github.workflow_sha }}");
  }
  for (const name of ["analysis", "premerge", "ci", "select", "reserve", "assess", "finalize"])
    assert.doesNotMatch(JSON.stringify(w.jobs[name]), /secrets\./);
  assert.equal(w.jobs.review.with.phase, "review");
  assert.equal(w.jobs.review.with.slot, "dependency");
  assert.deepEqual(w.jobs.assess.permissions, {
    contents: "write",
    "pull-requests": "read",
    actions: "read",
    checks: "write",
  });
  assert.deepEqual(w.jobs.review.permissions, {
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
