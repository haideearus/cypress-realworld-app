const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { GitHub, Ledger, ROOT } = require("../factory/github.cjs");
const { criteriaHash } = require("../factory/controller.cjs");
const { vars, context, head, GitHubFixture } = require("./helpers/factory-fixtures.cjs");
let implementation;
try {
  implementation = require("../factory/merge.cjs");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
const workflowRef = `${policy.REPOSITORY}/.github/workflows/factory-automatic.yml@refs/heads/main`;
const automaticContext = {
  ...context,
  event: "schedule",
  workflowRef,
  workflowSha: "b".repeat(40),
  runId: "200",
};
const config = {
  ...policy.readConfig(vars),
  automatic: true,
  autoMerge: true,
  appClientId: "Iv1.fixture",
  appSlug: "fixture-factory",
};
const copy = (value) => structuredClone(value);
class MergeFixture extends GitHubFixture {
  constructor() {
    super();
    this.issue = {
      number: 10,
      state: "open",
      title: "Repair demo",
      body: "Repair the testable bug",
      user: { login: policy.OWNER },
    };
    this.pr = {
      number: 20,
      state: "open",
      merged: false,
      draft: false,
      mergeable: true,
      mergeable_state: "clean",
      user: { login: "fixture-factory[bot]" },
      head: { sha: head, ref: "agent/factory-10", repo: { full_name: policy.REPOSITORY } },
      base: { ref: "main", repo: { full_name: policy.REPOSITORY } },
    };
    const association = {
      id: 10020,
      number: 20,
      url: `https://api.github.com${ROOT}/pulls/20`,
      head: {
        sha: head,
        ref: "agent/factory-10",
        repo: { id: 100, name: "cypress-realworld-app", url: `https://api.github.com${ROOT}` },
      },
      base: {
        sha: "b".repeat(40),
        ref: "main",
        repo: { id: 100, name: "cypress-realworld-app", url: `https://api.github.com${ROOT}` },
      },
    };
    this.checks = [
      {
        id: 101,
        name: "verify",
        head_sha: head,
        status: "completed",
        conclusion: "success",
        app: { id: 15368, slug: "github-actions" },
        check_suite: { id: 601 },
        pull_requests: [copy(association)],
        details_url: `https://github.com/${policy.REPOSITORY}/actions/runs/501/job/701`,
      },
      {
        id: 102,
        name: "Factory review gate",
        head_sha: head,
        status: "completed",
        conclusion: "success",
        app: { id: 15368, slug: "github-actions" },
        check_suite: { id: 602 },
        pull_requests: [copy(association)],
        details_url: `https://github.com/${policy.REPOSITORY}/actions/runs/502/job/702`,
      },
    ];
    this.runs = new Map([
      [501, this.nativeRun(501, "factory-ci.yml", 601, association)],
      [502, this.nativeRun(502, "factory-review-status.yml", 602, association)],
      [
        503,
        {
          id: 503,
          head_sha: head,
          display_title: "Factory CI / 11111111-1111-4111-8111-111111111111",
          event: "workflow_dispatch",
          path: ".github/workflows/factory-ci.yml",
          status: "completed",
          conclusion: "success",
        },
      ],
    ]);
    this.runStatuses = new Map();
    this.files = [{ filename: "src/example.ts", status: "modified" }];
    this.refreshCompletes = true;
    this.mergeResponse = "success";
    this.beforeMerge = null;
    this.extraCalls = [];
    const ledgerFetch = this.fetch;
    this.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname.slice(ROOT.length);
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : null;
      const reply = (status, value) =>
        new Response(value === null ? null : JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
      this.extraCalls.push({ path, method, body });
      if (method === "GET" && path === "/issues/10") return reply(200, this.issue);
      if (method === "GET" && path === "/pulls/20") return reply(200, this.pr);
      if (method === "GET" && path === "/pulls/20/files") return reply(200, this.files);
      if (method === "GET" && path === `/commits/${head}/check-runs`)
        return reply(200, { check_runs: this.checks });
      const run = /^\/actions\/runs\/(\d+)$/.exec(path);
      if (method === "GET" && run) return reply(200, this.runs.get(Number(run[1])) || {});
      const jobs = /^\/actions\/runs\/(\d+)\/jobs$/.exec(path);
      if (method === "GET" && jobs) {
        const id = Number(jobs[1]);
        if (id === 503)
          return reply(200, {
            jobs: [{ name: "verify", status: "completed", conclusion: "success" }],
          });
        const check = this.checks.find((item) => item.details_url.includes(`/runs/${id}/`));
        return reply(200, {
          jobs: check
            ? [
                {
                  id: id + 200,
                  run_id: id,
                  name: check.name,
                  check_run_url: `https://api.github.com${ROOT}/check-runs/${check.id}`,
                  status: check.status,
                  conclusion: check.conclusion,
                },
              ]
            : [],
        });
      }
      const attempt = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(path);
      if (method === "GET" && attempt)
        return reply(200, { status: this.runStatuses.get(attempt[1]) || "completed" });
      if (method === "POST" && path === "/actions/runs/502/rerun-failed-jobs") {
        if (this.refreshCompletes) {
          this.checks[1].conclusion = "success";
          this.runs.get(502).conclusion = "success";
          this.pr.mergeable = true;
          this.pr.mergeable_state = "clean";
        }
        return reply(201, {});
      }
      if (method === "PUT" && path === "/pulls/20/merge") {
        if (this.beforeMerge) await this.beforeMerge();
        if (body.sha !== this.pr.head.sha || this.pr.state !== "open")
          return reply(409, { message: "Head changed or PR closed" });
        if (["success", "lost-success"].includes(this.mergeResponse)) {
          this.pr.state = "closed";
          this.pr.merged = true;
          this.pr.merge_commit_sha = "c".repeat(40);
          this.issue.state = "closed";
        }
        if (this.mergeResponse.startsWith("lost")) throw new Error("Connection lost");
        return reply(200, { merged: true, sha: "c".repeat(40) });
      }
      return ledgerFetch(url, options);
    };
  }
  nativeRun(id, file, suite, association) {
    return {
      id,
      path: `.github/workflows/${file}`,
      event: "pull_request",
      head_sha: head,
      head_branch: "agent/factory-10",
      repository: { full_name: policy.REPOSITORY },
      head_repository: { full_name: policy.REPOSITORY },
      pull_requests: [copy(association)],
      check_suite_id: suite,
      status: "completed",
      conclusion: "success",
    };
  }
  mutations() {
    return this.extraCalls.filter((call) => call.method !== "GET");
  }
}
async function setup({ settings = {}, ctx = {} } = {}) {
  assert.equal(typeof implementation?.AutomaticMerger, "function", "missing automatic merger");
  const fixture = new MergeFixture();
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  await ledger.update((state) => {
    let reserved = policy.reserve(state, context, config);
    let next = policy.finish(reserved.state, reserved.grant.id, {
      status: "awaiting_review",
      head,
      pr: 20,
    });
    reserved = policy.reserve(next, { ...context, phase: "review" }, config);
    next = policy.finish(reserved.state, reserved.grant.id, {
      status: "reviewed",
      head,
      pr: 20,
      verdict: "pass",
      evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/100`,
    });
    Object.assign(next.tickets["10"], {
      criteriaHash: criteriaHash(fixture.issue),
      branch: "agent/factory-10",
      automatic: {
        workflowRef,
        workflowSha: "b".repeat(40),
        runId: "100",
        runAttempt: 1,
        appSlug: config.appSlug,
      },
      ci: { requestId: "11111111-1111-4111-8111-111111111111", runId: 503, head, passed: true },
    });
    return { state: next };
  });
  fixture.extraCalls = [];
  fixture.calls = [];
  const merger = new implementation.AutomaticMerger(
    api,
    { ...config, ...settings },
    { ...automaticContext, ...ctx },
    { sleep: async () => {}, maxPolls: 2 }
  );
  return { fixture, api, ledger, merger };
}
test("automatic merging uses protected expected-head API and keeps review/counters unchanged", async () => {
  const { fixture, ledger, merger } = await setup();
  const before = copy((await ledger.read()).state);
  const result = await merger.merge(10);
  assert.equal(result.merged, true);
  const after = (await ledger.read()).state;
  assert.deepEqual(after.grants, before.grants);
  assert.deepEqual(after.days, before.days);
  assert.deepEqual(after.tickets["10"].approval, before.tickets["10"].approval);
  assert.deepEqual(
    [after.tickets["10"].coding, after.tickets["10"].reviews, after.tickets["10"].retries],
    [1, 1, 0]
  );
  assert.equal(after.tickets["10"].merge.status, "merged");
  assert.equal(after.tickets["10"].merge.mergeCommit, "c".repeat(40));
  assert.equal(after.active, null);
  assert.deepEqual(fixture.extraCalls.find((call) => call.method === "PUT").body, {
    sha: head,
    merge_method: "squash",
  });
  assert.equal(
    fixture.extraCalls.some((call) => call.path === "/check-runs"),
    false
  );
});
for (const flag of ["enabled", "automatic", "autoMerge"])
  test(`disabled ${flag} causes no mutations`, async () => {
    const { fixture, merger } = await setup({ settings: { [flag]: false } });
    assert.equal((await merger.merge(10)).merged, false);
    assert.deepEqual(fixture.mutations(), []);
  });
test("dry run bypasses disabled flags but never changes ledger, refreshes checks or merges", async () => {
  const { fixture, merger, ledger } = await setup({
    settings: { enabled: false, automatic: false, autoMerge: false },
  });
  fixture.checks[1].conclusion = "failure";
  fixture.runs.get(502).conclusion = "failure";
  fixture.pr.mergeable_state = "blocked";
  const before = (await ledger.read()).commit;
  const result = await merger.merge(10, { dryRun: true });
  assert.equal(result.merged, false);
  assert.equal(result.dryRun, true);
  assert.equal((await ledger.read()).commit, before);
  assert.deepEqual(fixture.mutations(), []);
});
for (const [name, mutate] of [
  [
    "foreign workflow",
    (s) => {
      s.ctx.workflowRef = `${policy.REPOSITORY}/.github/workflows/factory-agents.yml@refs/heads/main`;
    },
  ],
  [
    "missing workflow SHA",
    (s) => {
      s.ctx.workflowSha = "";
    },
  ],
  [
    "foreign actor",
    (s) => {
      s.ctx.actor = "outsider";
    },
  ],
])
  test(`rejects ${name} in live and preview modes`, async () => {
    const values = { ctx: {} };
    mutate(values);
    const { merger, fixture } = await setup(values);
    await assert.rejects(merger.merge(10), /automatic|authorized|context/i);
    await assert.rejects(merger.merge(10, { dryRun: true }), /automatic|authorized|context/i);
    assert.deepEqual(fixture.mutations(), []);
  });
for (const [name, change] of [
  [
    "changed criteria",
    (f) => {
      f.issue.body = "Different acceptance criteria";
    },
  ],
  [
    "closed issue",
    (f) => {
      f.issue.state = "closed";
    },
  ],
  [
    "foreign issue author",
    (f) => {
      f.issue.user.login = "outsider";
    },
  ],
  [
    "changed PR head",
    (f) => {
      f.pr.head.sha = "d".repeat(40);
    },
  ],
  [
    "foreign PR author",
    (f) => {
      f.pr.user.login = policy.OWNER;
    },
  ],
  [
    "foreign PR repository",
    (f) => {
      f.pr.head.repo.full_name = "outsider/other";
    },
  ],
  [
    "foreign base repository",
    (f) => {
      f.pr.base.repo.full_name = "outsider/other";
    },
  ],
  [
    "wrong branch",
    (f) => {
      f.pr.head.ref = "agent/owner-harness";
    },
  ],
  [
    "wrong base",
    (f) => {
      f.pr.base.ref = "release";
    },
  ],
  [
    "draft",
    (f) => {
      f.pr.draft = true;
    },
  ],
  [
    "conflicts",
    (f) => {
      f.pr.mergeable = false;
    },
  ],
  [
    "unknown mergeability",
    (f) => {
      f.pr.mergeable = null;
    },
  ],
  [
    "blocked merge state",
    (f) => {
      f.pr.mergeable_state = "blocked";
    },
  ],
  [
    "missing native verify",
    (f) => {
      f.checks.shift();
    },
  ],
  [
    "missing native gate",
    (f) => {
      f.checks.pop();
    },
  ],
  [
    "foreign native verify source",
    (f) => {
      f.checks[0].app.id = 123;
    },
  ],
  [
    "stale native check",
    (f) => {
      f.checks[0].head_sha = "d".repeat(40);
    },
  ],
  [
    "latest failed native verify",
    (f) => {
      f.checks.push({ ...copy(f.checks[0]), id: 200, conclusion: "failure" });
    },
  ],
  [
    "unrelated native workflow",
    (f) => {
      f.runs.get(501).path = ".github/workflows/factory-model.yml";
    },
  ],
  [
    "dispatch check in place of PR CI",
    (f) => {
      f.runs.get(501).event = "workflow_dispatch";
    },
  ],
  [
    "wrong PR check association",
    (f) => {
      f.checks[0].pull_requests[0].number = 21;
    },
  ],
  [
    "wrong PR run association",
    (f) => {
      f.runs.get(501).pull_requests[0].head.sha = "d".repeat(40);
    },
  ],
  [
    "foreign native repository",
    (f) => {
      f.runs.get(501).repository.full_name = "outsider/other";
    },
  ],
  [
    "foreign check suite",
    (f) => {
      f.runs.get(501).check_suite_id = 999;
    },
  ],
  [
    "uncorrelated durable CI",
    (f) => {
      f.runs.get(503).display_title = "Factory CI / different-dispatch";
    },
  ],
  [
    "harness file",
    (f) => {
      f.files = [{ filename: ".github/workflows/factory-ci.yml", status: "modified" }];
    },
  ],
  [
    "renamed harness file",
    (f) => {
      f.files = [{ filename: "README.md", previous_filename: "AGENTS.md", status: "renamed" }];
    },
  ],
])
  test(`refuses ${name} before a merge or metadata refresh`, async () => {
    const { fixture, merger } = await setup();
    change(fixture);
    await assert.rejects(merger.merge(10));
    assert.equal(
      fixture.mutations().some((call) => call.method === "PUT" || call.path.includes("rerun")),
      false
    );
  });
for (const [name, mutate] of [
  [
    "manual ticket",
    (t) => {
      delete t.automatic;
    },
  ],
  [
    "owner PR ticket",
    (t) => {
      delete t.automatic;
      t.origin = "owner-pr";
    },
  ],
  [
    "other configured App",
    (t) => {
      t.automatic.appSlug = "other-app";
    },
  ],
  [
    "stale approval",
    (t) => {
      t.approval.head = "d".repeat(40);
    },
  ],
  [
    "fixture approval",
    (t) => {
      t.approval.fixture = true;
    },
  ],
])
  test(`refuses ${name} without a merge`, async () => {
    const { fixture, api, ledger, merger } = await setup();
    // Build malformed server state directly: the real Ledger must reject invalid provenance too.
    const state = copy((await ledger.read()).state);
    mutate(state.tickets["10"]);
    const blob = fixture.object({ content: Buffer.from(JSON.stringify(state)).toString("base64") });
    const tree = fixture.object({ tree: [{ path: "state.json", sha: blob }] });
    fixture.head = fixture.object({ tree, parents: [fixture.head] });
    void api;
    fixture.extraCalls = [];
    await assert.rejects(merger.merge(10));
    assert.deepEqual(fixture.mutations(), []);
  });
test("an active ticket prevents a merge even when review and all required checks pass", async () => {
  const { ledger, merger, fixture } = await setup();
  await ledger.update((state) => {
    state.active = { ticket: 10, runId: "999", runAttempt: 1 };
    return { state };
  });
  fixture.extraCalls = [];
  await assert.rejects(merger.merge(10), /active|lock/i);
  assert.deepEqual(fixture.mutations(), []);
});
test("only the exact failed native metadata gate is refreshed after genuine approval", async () => {
  const { fixture, merger } = await setup();
  fixture.checks[1].conclusion = "failure";
  fixture.runs.get(502).conclusion = "failure";
  fixture.pr.mergeable_state = "blocked";
  assert.equal((await merger.merge(10)).merged, true);
  const reruns = fixture.mutations().filter((call) => call.path.includes("rerun"));
  assert.deepEqual(
    reruns.map((call) => call.path),
    ["/actions/runs/502/rerun-failed-jobs"]
  );
});
test("metadata refresh has a bounded wait and never reruns model or unrelated checks", async () => {
  const { fixture, merger, ledger } = await setup();
  fixture.checks[1].conclusion = "failure";
  fixture.runs.get(502).conclusion = "failure";
  fixture.refreshCompletes = false;
  await assert.rejects(merger.merge(10), /timed out|pending|gate/i);
  assert.equal(fixture.mutations().filter((call) => call.path.includes("rerun")).length, 1);
  assert.equal(
    fixture.mutations().some((call) => call.method === "PUT"),
    false
  );
  assert.equal((await ledger.read()).state.tickets["10"].merge, undefined);
  assert.equal((await ledger.read()).state.active, null);
});
test("repeated successful ticks reconcile the closed merged PR without another PUT", async () => {
  const { fixture, merger } = await setup();
  await merger.merge(10);
  assert.equal((await merger.merge(10)).merged, true);
  assert.equal(fixture.mutations().filter((call) => call.method === "PUT").length, 1);
});
test("uncertain successful merge is reconciled from actual PR state and merge commit", async () => {
  const { fixture, merger, ledger } = await setup();
  fixture.mergeResponse = "lost-success";
  assert.equal((await merger.merge(10)).merged, true);
  assert.equal((await ledger.read()).state.tickets["10"].merge.mergeCommit, "c".repeat(40));
  assert.equal(fixture.mutations().filter((call) => call.method === "PUT").length, 1);
});
test("uncertain unmerged response retains intent and duplicate ticks do not retry", async () => {
  const { fixture, merger, ledger } = await setup();
  fixture.mergeResponse = "lost-unmerged";
  const first = await merger.merge(10);
  assert.equal(first.merged, false);
  assert.equal(first.pending, true);
  assert.equal((await ledger.read()).state.tickets["10"].merge.status, "intent");
  assert.deepEqual((await ledger.read()).state.active, { ticket: 10, runId: "200", runAttempt: 1 });
  assert.equal((await merger.merge(10)).pending, true);
  assert.equal(fixture.mutations().filter((call) => call.method === "PUT").length, 1);
});
test("a later tick only retries a prior completed attempt after reconciling unmerged state", async () => {
  const { fixture, merger, ledger, api } = await setup();
  fixture.mergeResponse = "lost-unmerged";
  await merger.merge(10);
  fixture.mergeResponse = "success";
  fixture.runStatuses.set("200", "in_progress");
  const next = new implementation.AutomaticMerger(
    api,
    config,
    { ...automaticContext, runId: "201" },
    { sleep: async () => {}, maxPolls: 2 }
  );
  assert.equal((await next.merge(10)).pending, true);
  fixture.runStatuses.set("200", "completed");
  assert.equal((await next.merge(10)).merged, true);
  assert.equal((await ledger.read()).state.tickets["10"].merge.runId, "201");
  assert.equal(fixture.mutations().filter((call) => call.method === "PUT").length, 2);
});
test("concurrent ticks acquire one durable intent and make at most one merge request", async () => {
  const { fixture, merger, api, ledger } = await setup();
  const other = new implementation.AutomaticMerger(
    api,
    config,
    { ...automaticContext, runId: "201" },
    { sleep: async () => {}, maxPolls: 2 }
  );
  fixture.runStatuses.set("200", "in_progress");
  fixture.runStatuses.set("201", "in_progress");
  const results = await Promise.all([merger.merge(10), other.merge(10)]);
  assert.equal(
    results.some((result) => result.merged),
    true
  );
  assert.equal(fixture.mutations().filter((call) => call.method === "PUT").length, 1);
  assert.equal((await ledger.read()).state.tickets["10"].merge.status, "merged");
});
test("closed unmerged PR becomes terminal without merging or resetting approval", async () => {
  const { fixture, merger, ledger } = await setup();
  fixture.pr.state = "closed";
  const approval = copy((await ledger.read()).state.tickets["10"].approval);
  const result = await merger.merge(10);
  assert.equal(result.closed, true);
  const state = (await ledger.read()).state;
  assert.equal(state.tickets["10"].merge.status, "closed");
  assert.deepEqual(state.tickets["10"].approval, approval);
  assert.equal(
    fixture.mutations().some((call) => call.method === "PUT"),
    false
  );
});
test("head race at merge API never records a false merge", async () => {
  const { fixture, merger, ledger } = await setup();
  fixture.beforeMerge = async () => {
    fixture.pr.head.sha = "d".repeat(40);
  };
  await assert.rejects(merger.merge(10), /head|identity/i);
  assert.equal((await ledger.read()).state.tickets["10"].merge.status, "intent");
});
test("the newer exact correlated dispatch verify does not replace native PR verification", async () => {
  const { fixture, merger } = await setup();
  const dispatched = copy(fixture.checks[0]);
  dispatched.id = 103;
  dispatched.details_url = `https://github.com/${policy.REPOSITORY}/actions/runs/503/job/703`;
  dispatched.check_suite.id = 603;
  dispatched.pull_requests = [];
  fixture.runs.get(503).check_suite_id = 603;
  fixture.checks.push(dispatched);
  assert.equal((await merger.merge(10)).merged, true);
});
test("a pending merge durably prevents manual coding from consuming another reservation", async () => {
  const { fixture, merger, ledger } = await setup();
  fixture.mergeResponse = "lost-unmerged";
  await merger.merge(10);
  const before = copy((await ledger.read()).state);
  await assert.rejects(
    ledger.update((state) =>
      policy.reserve(
        state,
        {
          ...context,
          runId: "300",
          ticket: 11,
        },
        config
      )
    ),
    /active|lock/i
  );
  assert.deepEqual((await ledger.read()).state, before);
});
test("ledger lock is held before PUT and released on confirmed merge", async () => {
  const { fixture, merger, ledger } = await setup();
  fixture.beforeMerge = async () => {
    const state = (await ledger.read()).state;
    assert.deepEqual(state.active, { ticket: 10, runId: "200", runAttempt: 1 });
    assert.equal(state.tickets["10"].merge.status, "intent");
  };
  assert.equal((await merger.merge(10)).merged, true);
  assert.equal((await ledger.read()).state.active, null);
});
