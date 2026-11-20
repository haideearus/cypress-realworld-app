const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const d = require("../factory/dependency-contract.cjs");
const a = require("../factory/dependency-alert-repair.cjs");
const { toolsAt } = require("../factory/dependency-analysis.cjs");
const { GitHub, Ledger, ROOT } = require("../factory/github.cjs");
const policy = require("../factory/policy.cjs");
const { DependencyCoordinator } = require("../factory/dependencies.cjs");
const { GitHubFixture, vars, context } = require("./helpers/factory-fixtures.cjs");
const tools = toolsAt(path.resolve(__dirname, "../factory/dependency-tools"));

const key = "c".repeat(64);
const base = "a".repeat(40);
const head = "b".repeat(40);
const app = { alertRepair: true, appSlug: "factory-example" };
const repo = { full_name: d.REPOSITORY };
const pr = {
  number: 9,
  state: "open",
  draft: false,
  user: { login: "factory-example[bot]", type: "Bot", id: 800 },
  head: { ref: d.alertBranch(key), sha: head, repo },
  base: { ref: "main", sha: base, repo },
};

test("alert proposals require the opt-in and the configured App identity", () => {
  assert.throws(() => d.prOK(pr), /Untrusted/);
  assert.throws(() => d.prOK(pr, false, { ...app, alertRepair: false }), /Untrusted/);
  assert.throws(() => d.prOK(pr, false, { ...app, appSlug: "different-app" }), /Untrusted/);
  assert.equal(d.prOK(pr, false, app), pr);
});

test("alert PR admission requires its exact ready ticket and recorded head", async () => {
  const record = {
    name: "example",
    candidate: "1.1.0",
    day: "2026-11-20",
    base,
    head,
    issue: 8,
    pr: 9,
    phase: "ready",
  };
  let issue = {
    number: 8,
    state: "open",
    user: { login: "github-actions[bot]", id: 41898282 },
    labels: [{ name: a.READY_LABEL }],
    title: a.issueTitle(record),
    body: a.issueBody(key, record),
  };
  const api = { request: async () => issue };
  const store = { read: async () => ({ state: { records: { [key]: record } } }) };
  assert.equal((await a.verifyAlertPR(api, pr, app, store)).issue, 8);
  await assert.rejects(
    a.verifyAlertPR(api, { ...pr, head: { ...pr.head, sha: base } }, app, store)
  );
  issue = { ...issue, labels: [] };
  await assert.rejects(a.verifyAlertPR(api, pr, app, store));
});

test("lockfile-only generation updates exact selectors and holds changed dependency edges", () => {
  const sri = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const initial = {
    "example@^1.0.0": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
      integrity: sri,
    },
  };
  const lock = tools.lockfile.stringify(initial);
  const plan = { package: "example", locked: ["1.0.0"], candidate: "1.1.0" };
  const release = {
    name: "example",
    version: "1.1.0",
    dist: {
      tarball: "https://registry.npmjs.org/example/-/example-1.1.0.tgz",
      integrity: sri,
      shasum: base,
    },
  };
  const updated = a.patchLock(lock, plan, release, tools);
  assert.equal(tools.lockfile.parse(updated).object["example@^1.0.0"].version, "1.1.0");
  assert.throws(
    () => a.patchLock(lock, plan, { ...release, dependencies: { child: "^1.0.0" } }, tools),
    /dependency graph/
  );
  assert.throws(
    () =>
      a.patchLock(
        lock,
        plan,
        { ...release, dist: { ...release.dist, tarball: "https://example.invalid/x" } },
        tools
      ),
    /registry/
  );
});

async function pipeline() {
  const f = new GitHubFixture();
  const oldFetch = f.fetch;
  const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const lock = tools.lockfile.stringify({
    "example@^1.0.0": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
      integrity,
    },
  });
  let registryHead;
  const store = {
    read: async () => {
      const commit = f.objects.get(registryHead);
      const tree = f.objects.get(commit.tree);
      const blob = f.objects.get(tree.tree[0].sha);
      return { state: JSON.parse(Buffer.from(blob.content, "base64").toString("utf8")) };
    },
  };
  const fixture = { main: base, issuePosts: 0, prPosts: 0, labelPosts: 0, ref: null };
  const locked = () => {
    const commit = f.objects.get(fixture.ref);
    const tree = f.objects.get(commit.tree);
    return Buffer.from(f.objects.get(tree.tree[0].sha).content, "base64").toString("utf8");
  };
  f.fetch = async (url, request) => {
    const endpoint = url.pathname.slice(ROOT.length);
    const data = request.body && JSON.parse(request.body);
    const response = (body) => Response.json(body);
    if (request.method === "GET") {
      if (endpoint === "/git/ref/heads/main") return response({ object: { sha: fixture.main } });
      if (endpoint === "/git/ref/heads/factory/dependency-alerts")
        return registryHead
          ? response({ object: { sha: registryHead } })
          : new Response(null, { status: 404 });
      if (endpoint === "/contents/dependency-alerts.json") {
        assert.equal(url.searchParams.get("ref"), registryHead);
        const { state } = await store.read();
        return response({
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(state)).toString("base64"),
        });
      }
      if (endpoint === "/contents/yarn.lock") {
        const text = url.searchParams.get("ref") === base ? lock : locked();
        return response({
          type: "file",
          path: "yarn.lock",
          encoding: "base64",
          content: Buffer.from(text).toString("base64"),
          size: Buffer.byteLength(text),
        });
      }
      if (endpoint.startsWith("/git/ref/heads/agent/dependency-alert-"))
        return fixture.ref
          ? response({ object: { sha: fixture.ref } })
          : new Response(null, { status: 404 });
      if (endpoint === `/git/commits/${fixture.main}`) return response({ tree: { sha: head } });
      if (endpoint === "/issues")
        return response(fixture.issue && !url.searchParams.has("labels") ? [fixture.issue] : []);
      if (endpoint === "/issues/8") return response(fixture.issue);
      if (endpoint === "/pulls") return response(fixture.pr ? [fixture.pr] : []);
      if (endpoint === "/pulls/9") return response(fixture.pr);
      if (endpoint === "/pulls/9/files")
        return response([{ filename: "yarn.lock", status: "modified" }]);
      if (endpoint.startsWith("/compare/"))
        return response({
          behind_by: 0,
          merge_base_commit: { sha: fixture.main },
          status: "identical",
        });
      if (endpoint.startsWith("/labels/")) return response({ name: endpoint.split("/").at(-1) });
    }
    if (
      request.method === "POST" &&
      endpoint === "/git/refs" &&
      data.ref === "refs/heads/factory/dependency-alerts"
    ) {
      assert.equal(registryHead, undefined);
      registryHead = data.sha;
      return response({ object: { sha: registryHead } });
    }
    if (request.method === "PATCH" && endpoint === "/git/refs/heads/factory/dependency-alerts") {
      assert.equal(data.force, false);
      assert.deepEqual(f.objects.get(data.sha).parents, [registryHead]);
      registryHead = data.sha;
      return response({ object: { sha: registryHead } });
    }
    if (
      request.method === "POST" &&
      endpoint === "/git/refs" &&
      data.ref.startsWith("refs/heads/agent/")
    ) {
      fixture.ref = data.sha;
      return response({ object: { sha: fixture.ref } });
    }
    if (
      request.method === "PATCH" &&
      endpoint.startsWith("/git/refs/heads/agent/dependency-alert-")
    ) {
      assert.equal(request.headers.Authorization, "Bearer publisher-fixture");
      assert.equal(data.force, false);
      assert.deepEqual(f.objects.get(data.sha).parents, [fixture.main, fixture.ref]);
      fixture.ref = data.sha;
      fixture.pr.head.sha = data.sha;
      return response({ object: { sha: fixture.ref } });
    }
    if (request.method === "POST" && endpoint === "/issues") {
      fixture.issuePosts++;
      fixture.issue = {
        ...data,
        number: 8,
        state: "open",
        user: { login: "github-actions[bot]", id: 41898282 },
        labels: data.labels.map((name) => ({ name })),
      };
      if (fixture.lostIssueResponse) throw Error("lost response");
      return response(fixture.issue);
    }
    if (request.method === "POST" && endpoint === "/pulls") {
      fixture.prPosts++;
      assert.equal(request.headers.Authorization, "Bearer publisher-fixture");
      fixture.pr = {
        ...pr,
        title: data.title,
        body: data.body,
        base: { ...pr.base, sha: fixture.main },
        head: { ...pr.head, ref: data.head, sha: fixture.ref },
      };
      return response(fixture.pr);
    }
    if (request.method === "POST" && endpoint === "/issues/8/labels") {
      fixture.labelPosts++;
      fixture.issue.labels = data.labels.map((name) => ({ name }));
      return response(fixture.issue.labels);
    }
    if (request.method === "DELETE" && endpoint === "/issues/8/labels/factory-dependency-held") {
      fixture.issue.labels = fixture.issue.labels.filter(
        (label) => label.name !== "factory-dependency-held"
      );
      return response(fixture.issue.labels);
    }
    if (request.method === "PATCH" && endpoint === "/issues/8") {
      fixture.issue = { ...fixture.issue, ...data };
      if (data.body && fixture.lostIssueUpdateResponse) throw Error("lost issue update response");
      return response(fixture.issue);
    }
    return oldFetch(url, request);
  };
  const api = new GitHub({ token: "job-fixture", fetch: f.fetch });
  const appApi = new GitHub({ token: "publisher-fixture", fetch: f.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  const cfg = policy.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_DEPENDENCY_ALERT_REPAIR_ENABLED: "true",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
    FACTORY_GITHUB_APP_SLUG: "factory-example",
  });
  const ctx = { ...context, workflowRef: d.WORKFLOW, workflowSha: base, event: "schedule" };
  const transport = async (url, request) => {
    if (String(url).includes("/dependabot/alerts") && fixture.alertCleared)
      return Response.json([]);
    if (String(url).includes("/dependabot/alerts"))
      return Response.json([
        {
          number: fixture.alertNumber || 1,
          state: "open",
          dependency: {
            package: { ecosystem: "npm", name: "example" },
            manifest_path: "yarn.lock",
            scope: "runtime",
          },
          security_vulnerability: {
            severity: "high",
            vulnerable_version_range: "<1.1.0",
            first_patched_version: { identifier: "1.1.0" },
          },
        },
      ]);
    if (String(url).includes("/advisories"))
      return fixture.advisoriesUnavailable
        ? new Response(null, { status: 503 })
        : Response.json([]);
    if (String(url).endsWith("registry.npmjs.org/example"))
      return Response.json({ versions: fixture.versions || { "1.1.0": {} } });
    if (String(url).endsWith("registry.npmjs.org/example/1.1.0"))
      return Response.json({
        name: "example",
        version: "1.1.0",
        ...(fixture.releaseDependencies && { dependencies: fixture.releaseDependencies }),
        dist: {
          tarball: "https://registry.npmjs.org/example/-/example-1.1.0.tgz",
          shasum: base,
          integrity,
        },
      });
    if (String(url).includes("api.osv.dev")) {
      const queries = JSON.parse(request.body).queries;
      return Response.json({
        results: queries.map((q) =>
          q.version === "1.0.0" ? { vulns: [{ id: "GHSA-example" }] } : {}
        ),
      });
    }
    throw Error("unexpected metadata request");
  };
  const run = (config = cfg) =>
    a.runRepair({
      api,
      app: appApi,
      token: "alerts-fixture",
      config,
      base: fixture.main,
      lock: fixture.lockUpdated ? locked() : lock,
      manifest: JSON.stringify({ dependencies: { example: "^1.0.0" } }),
      tools,
      transport,
    });
  async function reviewed() {
    assert.equal((await new DependencyCoordinator(api, cfg, ctx).select(false)).ready, true);
    return ledger.update((state) => {
      const ticket = state.tickets[9];
      ticket.ci = { head: ticket.head, passed: true, runId: 19 };
      const { reportFor, toolDigest } = require("../factory/dependency-analysis.cjs");
      ticket.analysis = reportFor(
        {
          repository: d.REPOSITORY,
          pr: 9,
          base: fixture.main,
          head: ticket.head,
          workflowSha: ctx.workflowSha,
          runId: ctx.runId,
          runAttempt: 1,
          stage: "analysis",
          toolDigest: toolDigest(),
        },
        { changed: 2, candidateVersions: 1, cleared: [], remainingBaseline: [] }
      );
      const reserved = require("../factory/dependency-policy.cjs").reserveDependencyReview(
        state,
        ctx,
        cfg
      );
      return {
        state: policy.finish(reserved.state, reserved.grant.id, {
          status: "reviewed",
          head: ticket.head,
          pr: 9,
          verdict: "pass",
          evidence: `https://github.com/${d.REPOSITORY}/actions/runs/${ctx.runId}`,
        }),
      };
    });
  }
  return {
    fixture,
    store,
    ledger,
    run,
    reviewed,
    coordinator: new DependencyCoordinator(api, cfg, ctx),
    cfg,
  };
}

test("a wider dependency update gets one labeled tracking issue across main and alert changes", async () => {
  const x = await pipeline();
  x.fixture.versions = { "2.0.0": {} };
  const tracked = await x.run();
  assert.equal(tracked.outcome, "tracked-held");
  assert.equal(tracked.issue, x.fixture.issue.number);
  assert.equal(x.fixture.issuePosts, 1);
  assert.deepEqual(x.fixture.issue.labels, [{ name: "factory-dependency-held" }]);
  assert.match(x.fixture.issue.body, /major|release line/i);
  assert.match(x.fixture.issue.body, /next step/i);
  assert.equal(x.fixture.prPosts, 0);
  assert.equal(x.fixture.ref, null);
  assert.equal((await x.coordinator.select(false)).ready, false);
  x.fixture.main = "f".repeat(40);
  x.fixture.alertNumber = 2;
  await x.run();
  assert.equal(x.fixture.issuePosts, 1);
  const { state } = await x.ledger.read();
  assert.deepEqual(state.grants, {});
  assert.deepEqual(state.days, {});
});

test("a compatible release with changed dependency edges gets a held issue without a PR", async () => {
  const x = await pipeline();
  x.fixture.releaseDependencies = { child: "^1.0.0" };
  assert.equal((await x.run()).outcome, "tracked-held");
  assert.match(x.fixture.issue.body, /dependency graph/i);
  assert.match(x.fixture.issue.body, /parent/i);
  assert.equal(x.fixture.prPosts, 0);
  assert.equal(x.fixture.ref, null);
});

test("a held alert becomes a protected proposal on the same issue when evidence supports it", async () => {
  const x = await pipeline();
  x.fixture.advisoriesUnavailable = true;
  assert.equal((await x.run()).outcome, "tracked-held");
  assert.match(x.fixture.issue.body, /advisory|metadata/i);
  const issue = x.fixture.issue.number;
  x.fixture.advisoriesUnavailable = false;
  const published = await x.run();
  assert.equal(published.outcome, "published");
  assert.equal(published.issue, issue);
  assert.equal(published.pr, 9);
  assert.equal(x.fixture.issue.number, issue);
  assert.equal(x.fixture.issuePosts, 1);
  assert.equal(x.fixture.prPosts, 1);
  assert.match(x.fixture.issue.body, new RegExp(`https://github.com/${d.REPOSITORY}/pull/9`));
  assert.deepEqual(x.fixture.issue.labels, [{ name: a.READY_LABEL }]);
  assert.equal((await x.coordinator.select(false)).ready, true);
});

test("promotion recovers a lost response when linking the exact PR from the tracking issue", async () => {
  const x = await pipeline();
  x.fixture.advisoriesUnavailable = true;
  await x.run();
  x.fixture.advisoriesUnavailable = false;
  x.fixture.lostIssueUpdateResponse = true;
  await assert.rejects(x.run(), /lost issue update response/);
  assert.deepEqual(x.fixture.issue.labels, [{ name: "factory-dependency-held" }]);
  assert.equal((await x.coordinator.select(false)).ready, false);
  x.fixture.lostIssueUpdateResponse = false;
  assert.equal((await x.run()).outcome, "published");
  assert.equal(x.fixture.issuePosts, 1);
  assert.equal(x.fixture.prPosts, 1);
  assert.deepEqual(x.fixture.issue.labels, [{ name: a.READY_LABEL }]);
});

test("a lost held issue response reconciles the matching issue without reposting", async () => {
  const x = await pipeline();
  x.fixture.advisoriesUnavailable = true;
  x.fixture.lostIssueResponse = true;
  await assert.rejects(x.run(), /lost response/);
  assert.equal(x.fixture.issuePosts, 1);
  x.fixture.lostIssueResponse = false;
  assert.equal((await x.run()).outcome, "tracked-held");
  assert.equal(x.fixture.issuePosts, 1);
  assert.equal(x.fixture.prPosts, 0);
});

test("an unconfirmed held publication never reposts or admits a replacement proposal", async () => {
  const x = await pipeline();
  x.fixture.advisoriesUnavailable = true;
  x.fixture.lostIssueResponse = true;
  await assert.rejects(x.run(), /lost response/);
  x.fixture.issue = null;
  x.fixture.lostIssueResponse = false;
  x.fixture.advisoriesUnavailable = false;
  assert.equal((await x.run()).outcome, "held-publication-uncertain");
  await x.run();
  assert.equal(x.fixture.issuePosts, 1);
  assert.equal(x.fixture.prPosts, 0);
});

test("intake reconciles a lost issue response and exactly one linked PR enters the shared dependency ledger", async () => {
  const x = await pipeline();
  assert.deepEqual(await x.run({ ...x.cfg, alertRepair: false }), { outcome: "disabled" });
  assert.equal(x.fixture.issuePosts, 0);
  x.fixture.lostIssueResponse = true;
  await assert.rejects(x.run(), /lost response/);
  x.fixture.lostIssueResponse = false;
  assert.equal((await x.run()).outcome, "published");
  assert.equal(x.fixture.issuePosts, 1);
  assert.equal(x.fixture.prPosts, 1);
  assert.deepEqual(x.fixture.issue.labels, [{ name: a.READY_LABEL }]);
  assert.equal((await x.run()).outcome, "awaiting-dependency-pickup");
  assert.equal((await x.coordinator.select(false)).ready, true);
  const { state } = await x.ledger.read();
  assert.equal(state.active.ticket, 9);
  assert.equal(state.tickets[9].origin, "dependency-pr");
  assert.equal(Object.keys(state.grants).length, 0);
  assert.equal(Object.values(state.days).flat().length, 1);
});

test("a removed label stays held and a normal main advance refreshes the same proposal without force", async () => {
  const x = await pipeline();
  await x.run();
  const old = x.fixture.ref;
  x.fixture.main = "f".repeat(40);
  x.fixture.pr.base.sha = x.fixture.main;
  x.fixture.issue.labels = [];
  assert.equal((await x.run()).outcome, "no-compatible-update");
  assert.equal(x.fixture.labelPosts, 1);
  assert.equal(x.fixture.ref, old);
  x.fixture.issue.labels = [{ name: a.READY_LABEL }];
  assert.equal((await x.run()).outcome, "refreshed");
  assert.notEqual(x.fixture.ref, old);
  assert.equal(x.fixture.issuePosts, 1);
  assert.equal(x.fixture.prPosts, 1);
  assert.equal((await x.coordinator.select(true)).ticket, 9);
});

test("a reviewed ticket that is held or stale releases the shared queue and preserves its spent review", async () => {
  for (const reason of ["ticket-held", "stale-base", "alert-repair-disabled"]) {
    const x = await pipeline();
    await x.run();
    await x.reviewed();
    if (reason === "ticket-held") x.fixture.issue.labels = [];
    else if (reason === "stale-base") {
      x.fixture.main = "f".repeat(40);
      x.fixture.pr.base.sha = x.fixture.main;
    } else x.coordinator.config = { ...x.cfg, alertRepair: false };
    assert.deepEqual(await x.coordinator.select(true), { ready: false, reason });
    assert.equal((await x.coordinator.select(false)).ready, false);
    const { state } = await x.ledger.read();
    assert.equal(state.active, null);
    assert.equal(state.tickets[9].status, "blocked");
    assert.equal(state.tickets[9].reviews, 1);
    assert.equal(Object.values(state.grants)[0].outcome, "reviewed");
    assert.equal(state.tickets[9].approval, null);
  }
});

test("ticket closure waits for a proven merge, the fixed lock entries, and GitHub's alert refresh", async () => {
  const x = await pipeline();
  await x.run();
  await x.reviewed();
  const mergeCommit = "f".repeat(40);
  await x.ledger.update((state) => {
    const ticket = state.tickets[9];
    ticket.merge = {
      status: "merged",
      head: ticket.head,
      pr: 9,
      at: new Date().toISOString(),
      runId: context.runId,
      runAttempt: 1,
      mergeCommit,
    };
    return { state };
  });
  x.fixture.main = mergeCommit;
  x.fixture.pr = { ...x.fixture.pr, state: "closed", merged: true, merge_commit_sha: mergeCommit };
  await x.run();
  assert.equal(x.fixture.issue.state, "open");
  x.fixture.alertCleared = true;
  await assert.rejects(x.run(), /lacks verified merge/);
  assert.equal(x.fixture.issue.state, "open");
  x.fixture.lockUpdated = true;
  await x.run();
  assert.equal(x.fixture.issue.state_reason, "completed");
  assert.equal(Object.values((await x.store.read()).state.records)[0].phase, "resolved");
});

test("hosted preview stays read-only and alert publication is explicitly opt-in", () => {
  const fs = require("node:fs");
  const yaml = require("js-yaml");
  const workflow = yaml.load(
    fs.readFileSync(
      path.resolve(__dirname, "../../.github/workflows/factory-dependency-alerts.yml"),
      "utf8"
    )
  );
  assert.equal(workflow.on.workflow_dispatch.inputs.operation.default, "preview");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.preview.permissions, undefined);
  assert.match(workflow.jobs.repair.if, /FACTORY_DEPENDENCY_ALERT_REPAIR_ENABLED == 'true'/);
  assert.equal(workflow.jobs.repair.concurrency.group, "factory-ledger");
  assert.doesNotMatch(JSON.stringify(workflow), /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/);
  assert.ok(
    require("../factory/stop.cjs").AGENT_WORKFLOWS.includes(
      ".github/workflows/factory-dependency-alerts.yml"
    )
  );
});
