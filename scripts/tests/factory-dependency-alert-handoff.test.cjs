const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const d = require("../factory/dependency-contract.cjs");
const a = require("../factory/dependency-alert-repair.cjs");
const { toolsAt } = require("../factory/dependency-analysis.cjs");
const { GitHub, Ledger, ROOT } = require("../factory/github.cjs");
const { MetadataStore } = require("../factory/metadata-store.cjs");
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
  const issues = new Map();
  const store = {
    read: async () => {
      const commit = f.objects.get(registryHead);
      const tree = f.objects.get(commit.tree);
      const blob = f.objects.get(tree.tree[0].sha);
      return { state: JSON.parse(Buffer.from(blob.content, "base64").toString("utf8")) };
    },
  };
  const fixture = {
    main: base,
    issuePosts: 0,
    prPosts: 0,
    labelPosts: 0,
    ref: null,
    releaseReads: [],
  };
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
      if (
        endpoint === "/actions/workflows/factory-ci.yml" ||
        endpoint === "/actions/workflows/factory-agents.yml" ||
        endpoint === "/actions/workflows/factory-discovery.yml"
      )
        return response(fixture.ciWorkflow);
      if (endpoint === "/actions/runs/19") return response(fixture.ciRun);
      if (endpoint === "/actions/runs/19/attempts/1/jobs") {
        fixture.checkedCI = true;
        return response({ total_count: fixture.ciJobs.length, jobs: fixture.ciJobs });
      }
      if (endpoint === "/git/ref/heads/main")
        return response({ object: { sha: fixture.liveMain || fixture.main } });
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
        return response(
          !url.searchParams.has("labels")
            ? [...issues.values()].filter((issue) => issue.number !== 8 || fixture.issue)
            : []
        );
      if (/^\/issues\/\d+$/.test(endpoint))
        return issues.has(Number(endpoint.split("/").at(-1)))
          ? response(issues.get(Number(endpoint.split("/").at(-1))))
          : new Response(null, { status: 404 });
      if (endpoint === "/pulls") return response(fixture.pr ? [fixture.pr] : []);
      if (endpoint === "/pulls/9") return response(fixture.pr);
      if (endpoint === "/pulls/9/files")
        return response(fixture.cachedPrFiles || [{ filename: "yarn.lock", status: "modified" }]);
      if (endpoint.startsWith("/compare/"))
        return response({
          behind_by: 0,
          merge_base_commit: { sha: fixture.main },
          files: fixture.comparisonFiles || [{ filename: "yarn.lock", status: "modified" }],
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
      const issue = {
        ...data,
        number: 7 + fixture.issuePosts,
        state: "open",
        user: { login: "github-actions[bot]", id: 41898282 },
        labels: data.labels.map((name) => ({ name })),
      };
      issues.set(issue.number, issue);
      fixture.issue ??= issue;
      if (fixture.lostIssueResponse) throw Error("lost response");
      return response(issue);
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
      Object.assign(fixture.issue, data);
      if (data.body && fixture.lostIssueUpdateResponse) throw Error("lost issue update response");
      return response(fixture.issue);
    }
    return oldFetch(url, request);
  };
  const api = new GitHub({ token: "job-fixture", fetch: f.fetch });
  store.update = (mutator) =>
    new MetadataStore(
      api,
      "dependency-alerts",
      () => ({}),
      (state) => state
    ).update(mutator);
  const appApi = new GitHub({ token: "publisher-fixture", fetch: f.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  const cfg = policy.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_EVENT_PICKUP_ENABLED: "true",
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
        ...(fixture.extraAlerts || []),
      ]);
    if (String(url).includes("/advisories"))
      return fixture.advisoriesUnavailable
        ? new Response(null, { status: 503 })
        : Response.json([]);
    if (String(url).endsWith("registry.npmjs.org/example"))
      return Response.json({ versions: fixture.versions || { "1.1.0": {} } });
    if (url.hostname === "registry.npmjs.org" && url.pathname.startsWith("/example/")) {
      const version = url.pathname.split("/").at(-1);
      fixture.releaseReads.push(version);
      if (fixture.pauseDuringRelease === version) fixture.issue.labels = [];
      if (fixture.releaseUnavailable === version) return new Response(null, { status: 503 });
      return Response.json({
        name: "example",
        version,
        ...(fixture.releaseDependencies && { dependencies: fixture.releaseDependencies }),
        dist: {
          tarball: `https://registry.npmjs.org/example/-/example-${version}.tgz`,
          shasum: base,
          integrity,
        },
      });
    }
    if (String(url).includes("api.osv.dev")) {
      const queries = JSON.parse(request.body).queries;
      return Response.json({
        results: queries.map((q) =>
          q.version === "1.0.0" || fixture.vulnerableVersions?.includes(q.version)
            ? { vulns: [{ id: "GHSA-example" }] }
            : {}
        ),
      });
    }
    throw Error("unexpected metadata request");
  };
  const run = (config = cfg, trigger, now, reportHeldProgress = false) =>
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
      trigger,
      now,
      reportHeldProgress,
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
      const at = new Date().toISOString();
      ticket.dependency.attempts[0].evidence = [
        { at, finishedAt: at, status: "ready", digest: "d".repeat(64) },
      ];
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

test("the held queue finds a compatible repair outside the new-alert cursor", async () => {
  const x = await pipeline();
  x.fixture.versions = { "2.0.0": {} };
  assert.equal((await x.run()).outcome, "tracked-held");
  x.fixture.versions = { "1.1.0": {} };
  x.fixture.extraAlerts = [
    {
      number: 2,
      state: "open",
      dependency: {
        package: { ecosystem: "npm", name: "out-of-range" },
        manifest_path: "yarn.lock",
        scope: "development",
      },
      security_vulnerability: { severity: "medium", vulnerable_version_range: null },
    },
  ];
  await x.store.update((state) => {
    state.cursor = 1;
    state.records["c".repeat(64)] = {
      name: "out-of-range",
      phase: "tracking",
      trackingReason: "metadata-held",
      issue: 17,
      pr: null,
      day: "2026-11-21",
    };
    return { state };
  });
  assert.deepEqual(await x.run(), { outcome: "published", issue: 8, pr: 9 });
  assert.equal(x.fixture.issuePosts, 1);
  assert.equal(x.fixture.prPosts, 1);
  assert.equal((await x.store.read()).state.cursor, 1);
});

function additionalAlert(number, name, severity, scope = "runtime") {
  return {
    number,
    state: "open",
    dependency: { package: { ecosystem: "npm", name }, manifest_path: "yarn.lock", scope },
    security_vulnerability: { severity, vulnerable_version_range: null },
  };
}

test("held scanning moves past paused higher-priority tickets on the next run", async () => {
  const x = await pipeline();
  x.fixture.versions = { "2.0.0": {} };
  assert.equal((await x.run()).outcome, "tracked-held");
  x.fixture.versions = { "1.1.0": {} };
  x.fixture.extraAlerts = [];
  await x.store.update((state) => {
    for (let i = 1; i <= 3; i++) {
      const name = "paused-" + i;
      x.fixture.extraAlerts.push(additionalAlert(10 + i, name, "critical"));
      state.records[String(i).repeat(64)] = {
        name,
        phase: "tracking",
        trackingReason: "metadata-held",
        issue: 20 + i,
        pr: null,
        day: "2026-11-21",
      };
    }
    return { state };
  });
  assert.equal((await x.run()).outcome, "no-compatible-update");
  assert.deepEqual(await x.run(), { outcome: "published", issue: 8, pr: 9 });
});

test("a new critical runtime alert gets one turn before the reserved held queue", async () => {
  const x = await pipeline();
  const now = new Date("2026-11-22T12:00:00Z");
  x.fixture.versions = { "2.0.0": {} };
  assert.equal((await x.run(x.cfg, undefined, now)).outcome, "tracked-held");
  x.fixture.versions = { "1.1.0": {} };
  x.fixture.extraAlerts = [additionalAlert(2, "urgent", "critical")];
  assert.deepEqual(await x.run(x.cfg, undefined, now), { outcome: "tracked-held", issue: 9 });
  assert.equal((await x.store.read()).state.urgentDay, "2026-11-22");
  x.fixture.extraAlerts.push(additionalAlert(3, "another-urgent", "critical"));
  assert.deepEqual(await x.run(x.cfg, undefined, now), { outcome: "published", issue: 8, pr: 9 });
  assert.equal(x.fixture.issuePosts, 2);
});

test("a critical development alert cannot borrow runtime priority from another alert", async () => {
  const x = await pipeline();
  x.fixture.versions = { "2.0.0": {} };
  assert.equal((await x.run()).outcome, "tracked-held");
  x.fixture.versions = { "1.1.0": {} };
  x.fixture.extraAlerts = [
    additionalAlert(2, "mixed-scope", "critical", "development"),
    additionalAlert(3, "mixed-scope", "low", "runtime"),
  ];
  assert.deepEqual(await x.run(), { outcome: "published", issue: 8, pr: 9 });
  assert.equal(x.fixture.issuePosts, 1);
});

test("saving a confirmed held blocker does not end the scan of other candidates", async () => {
  const x = await pipeline();
  x.fixture.versions = { "2.0.0": {} };
  assert.equal((await x.run()).outcome, "tracked-held");
  x.fixture.versions = { "1.1.0": {} };
  x.fixture.vulnerableVersions = ["1.1.0"];
  x.fixture.extraAlerts = [additionalAlert(2, "new-alert", "medium", "development")];
  assert.deepEqual(await x.run(), { outcome: "tracked-held", issue: 9 });
  assert.match(x.fixture.issue.body, /Latest automatic recheck:/);
  assert.equal(x.fixture.prPosts, 0);
});

for (const cursor of [0, 11])
  test(`new-alert priority skips tracked packages after three held proposals at cursor ${cursor}`, async () => {
    const x = await pipeline();
    const now = new Date("2026-11-22T12:00:00Z");
    x.fixture.versions = { "2.0.0": {} };
    assert.equal((await x.run(x.cfg, undefined, now)).outcome, "tracked-held");
    x.fixture.versions = { "1.1.0": {} };
    x.fixture.extraAlerts = [additionalAlert(2, "new-alert", "medium", "development")];
    await x.store.update((state) => {
      state.cursor = cursor;
      for (let i = 1; i <= 3; i++)
        state.records[String(i).repeat(64)] = {
          name: "finished-" + i,
          phase: "resolved",
          trackingReason: "candidate-held",
          candidate: "1.1.0",
          base,
          head,
          issue: 20 + i,
          pr: 30 + i,
          day: "2026-11-22",
        };
      for (let i = 1; i <= 10; i++) {
        const name = "already-tracked-" + i;
        x.fixture.extraAlerts.push(additionalAlert(10 + i, name, i === 10 ? "low" : "critical"));
        state.records[i.toString(16).padStart(64, "0")] = {
          name,
          phase: "tracking",
          trackingReason: "metadata-held",
          issue: 40 + i,
          pr: null,
          day: "2026-11-21",
        };
      }
      return { state };
    });
    assert.deepEqual(await x.run(x.cfg, undefined, now), { outcome: "tracked-held", issue: 9 });
    assert.equal(x.fixture.prPosts, 0);
  });

test("a held ticket tries the next verified compatible release and refreshes the same PR", async () => {
  const x = await pipeline();
  x.fixture.versions = { "1.1.0": {}, "1.1.1": {} };
  x.fixture.vulnerableVersions = ["1.1.0"];
  const held = await x.run();
  assert.equal(held.outcome, "tracked-held");
  const published = await x.run();
  assert.deepEqual(published, { outcome: "published", issue: held.issue, pr: 9 });
  assert.deepEqual(x.fixture.releaseReads, ["1.1.0", "1.1.0", "1.1.1"]);
  assert.equal(x.fixture.issuePosts, 1);
  assert.equal(x.fixture.prPosts, 1);
  assert.match(x.fixture.pr.title, /1\.1\.1$/);
  x.fixture.main = "f".repeat(40);
  x.fixture.pr.base.sha = x.fixture.main;
  assert.equal((await x.run()).outcome, "refreshed");
  assert.equal(x.fixture.releaseReads.at(-1), "1.1.1");
  assert.equal(x.fixture.prPosts, 1);
  assert.equal((await x.coordinator.select(false)).ready, true);
});

test("a confirmed hold updates the original issue and skips repeated checks until evidence changes", async () => {
  const x = await pipeline();
  x.fixture.versions = { "1.1.0": {}, "1.1.1": {} };
  x.fixture.vulnerableVersions = ["1.1.0", "1.1.1"];
  const held = await x.run();
  assert.equal(held.outcome, "tracked-held");
  const checked = await x.run();
  assert.deepEqual(checked, { outcome: "held-rechecked", issue: held.issue });
  assert.match(x.fixture.issue.body, /latest automatic recheck/i);
  assert.match(x.fixture.issue.body, /still affect the tested release/i);
  assert.deepEqual(x.fixture.issue.labels, [{ name: "factory-dependency-held" }]);
  const reads = [...x.fixture.releaseReads];
  await x.run();
  assert.deepEqual(x.fixture.releaseReads, reads);
  x.fixture.versions["1.1.2"] = {};
  assert.deepEqual(await x.run(), { outcome: "published", issue: held.issue, pr: 9 });
  assert.match(x.fixture.pr.title, /1\.1\.2$/);
  assert.equal(x.fixture.issuePosts, 1);
  assert.equal(x.fixture.prPosts, 1);
  assert.deepEqual((await x.ledger.read()).state.grants, {});
});

test("held rechecks resume the next batch without retesting confirmed blocked releases", async () => {
  const x = await pipeline();
  x.fixture.versions = Object.fromEntries(Array.from({ length: 6 }, (_, i) => ["1.1." + i, {}]));
  x.fixture.vulnerableVersions = ["1.1.0", "1.1.1", "1.1.2", "1.1.3"];
  const held = await x.run();
  assert.equal((await x.run()).outcome, "held-rechecked");
  assert.deepEqual(x.fixture.releaseReads, ["1.1.0", "1.1.0", "1.1.1", "1.1.2", "1.1.3"]);
  assert.deepEqual(await x.run(), { outcome: "published", issue: held.issue, pr: 9 });
  assert.equal(x.fixture.releaseReads.at(-1), "1.1.4");
  assert.equal(x.fixture.releaseReads.length, 6);
  assert.match(x.fixture.pr.title, /1\.1\.4$/);
});

test("a held recheck preserves the confirmed prefix when later registry evidence is unavailable", async () => {
  const x = await pipeline();
  x.fixture.versions = { "1.1.0": {}, "1.1.1": {}, "1.1.2": {} };
  x.fixture.vulnerableVersions = ["1.1.0"];
  const held = await x.run();
  x.fixture.releaseUnavailable = "1.1.1";
  assert.deepEqual(await x.run(), { outcome: "held-rechecked", issue: held.issue });
  assert.deepEqual(x.fixture.releaseReads, ["1.1.0", "1.1.0", "1.1.1"]);
  assert.equal(x.fixture.prPosts, 0);
  x.fixture.releaseUnavailable = undefined;
  assert.deepEqual(await x.run(), { outcome: "published", issue: held.issue, pr: 9 });
  assert.deepEqual(x.fixture.releaseReads, ["1.1.0", "1.1.0", "1.1.1", "1.1.1"]);
});

test("an old partial recheck revisits earlier releases when only independent advisory data changes", async () => {
  const x = await pipeline();
  const start = new Date("2026-11-20T10:00:00Z");
  x.fixture.versions = { "1.1.0": {}, "1.1.1": {} };
  x.fixture.vulnerableVersions = ["1.1.0"];
  const held = await x.run(x.cfg, undefined, start);
  x.fixture.releaseUnavailable = "1.1.1";
  assert.equal((await x.run(x.cfg, undefined, start)).outcome, "held-rechecked");
  x.fixture.vulnerableVersions = [];
  const later = new Date("2026-11-27T10:00:01Z");
  assert.deepEqual(await x.run(x.cfg, undefined, later), {
    outcome: "published",
    issue: held.issue,
    pr: 9,
  });
  assert.match(x.fixture.pr.title, /1\.1\.0$/);
});

test("a ticket paused during verification keeps its tracking receipt and gets no proposal or note", async () => {
  for (const vulnerable of [false, true]) {
    const x = await pipeline();
    x.fixture.advisoriesUnavailable = true;
    await x.run();
    const before = x.fixture.issue.body;
    x.fixture.advisoriesUnavailable = false;
    x.fixture.pauseDuringRelease = "1.1.0";
    if (vulnerable) x.fixture.vulnerableVersions = ["1.1.0"];
    assert.equal((await x.run()).outcome, "no-compatible-update");
    assert.equal(x.fixture.issue.body, before);
    assert.equal(x.fixture.prPosts, 0);
    assert.equal(x.fixture.ref, null);
    const { state } = await x.store.read();
    const [row] = Object.values(state.records);
    assert.equal(row.phase, "tracking");
    assert.equal(row.recheck, undefined);
  }
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

async function pushRefresh(actor = { login: "haideearus", id: 101267861, type: "User" }) {
  const x = await pipeline();
  await x.run();
  x.fixture.main = "f".repeat(40);
  x.fixture.pr.base.sha = x.fixture.main;
  const workflow = { path: ".github/workflows/factory-ci.yml", id: 21 };
  const run = {
    id: 19,
    workflow_id: 21,
    path: workflow.path,
    event: "push",
    head_branch: "main",
    head_sha: x.fixture.main,
    repository: repo,
    head_repository: repo,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    actor,
    triggering_actor: actor,
  };
  x.fixture.ciWorkflow = workflow;
  x.fixture.ciRun = run;
  x.fixture.ciJobs = [
    {
      id: 22,
      run_id: 19,
      run_attempt: 1,
      head_sha: x.fixture.main,
      name: "verify",
      status: "completed",
      conclusion: "success",
    },
  ];
  const trigger = {
    env: {
      GITHUB_REPOSITORY: d.REPOSITORY,
      GITHUB_ACTOR: actor.login,
      GITHUB_ACTOR_ID: String(actor.id),
      GITHUB_TRIGGERING_ACTOR: actor.login,
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: x.fixture.main,
      GITHUB_WORKFLOW_SHA: x.fixture.main,
      GITHUB_WORKFLOW_REF: `${d.REPOSITORY}/.github/workflows/factory-dependency-alerts.yml@refs/heads/main`,
    },
    event: { action: "completed", repository: repo, workflow, workflow_run: { ...run } },
  };
  return { ...x, trigger };
}

test("successful main push CI refreshes the same proposal through the non-force App path", async () => {
  const x = await pushRefresh({ login: "factory-example[bot]", id: 800, type: "Bot" });
  const old = x.fixture.ref;
  assert.equal((await x.run(x.cfg, x.trigger)).outcome, "refreshed");
  assert.equal(x.fixture.checkedCI, true);
  assert.notEqual(x.fixture.ref, old);
  assert.equal(x.fixture.issuePosts, 1);
  assert.equal(x.fixture.prPosts, 1);
  assert.equal((await x.run(x.cfg, x.trigger)).outcome, "awaiting-dependency-pickup");
  assert.equal(Object.keys((await x.ledger.read()).state.grants).length, 0);
});

test("main push CI intake rejects PR, dispatch, forged, stale and unverified evidence", async () => {
  const changes = [
    (x) => {
      x.trigger.event.workflow_run.event = "pull_request";
    },
    (x) => {
      x.fixture.ciRun.event = "workflow_dispatch";
    },
    (x) => {
      x.fixture.ciRun.head_repository = { full_name: "other/fork" };
    },
    (x) => {
      x.fixture.ciRun.actor = { login: "haideearus", id: 1, type: "User" };
    },
    (x) => {
      x.fixture.ciRun.workflow_id = 20;
    },
    (x) => {
      x.fixture.ciRun.run_attempt = 2;
    },
    (x) => {
      x.fixture.ciRun.head_sha = base;
    },
    (x) => {
      x.fixture.ciJobs[0].head_sha = base;
    },
    (x) => {
      x.fixture.ciJobs[0].conclusion = "skipped";
    },
    (x) => {
      x.fixture.ciJobs.push(x.fixture.ciJobs[0]);
    },
  ];
  for (const change of changes) {
    const x = await pushRefresh();
    const old = x.fixture.ref;
    change(x);
    await assert.rejects(x.run(x.cfg, x.trigger), /Untrusted dependency alert/);
    assert.equal(x.fixture.ref, old);
    assert.equal(x.fixture.prPosts, 1);
  }
});

test("verified push CI cannot refresh after main advances again", async () => {
  const x = await pushRefresh();
  const old = x.fixture.ref;
  x.fixture.liveMain = "e".repeat(40);
  await assert.rejects(x.run(x.cfg, x.trigger), /Dependency alert preparation is stale/);
  assert.equal(x.fixture.ref, old);
});

for (const { name, event, actor } of [
  {
    name: "factory-agents",
    event: "workflow_dispatch",
    actor: { login: "haideearus", id: 101267861, type: "User" },
  },
  {
    name: "factory-discovery",
    event: "workflow_run",
    actor: { login: "factory-example[bot]", id: 800, type: "Bot" },
  },
])
  test(`a matching trusted ${name} slot release resumes a deferred held repair once`, async () => {
    const x = await pipeline();
    x.fixture.versions = { "2.0.0": {} };
    assert.equal((await x.run()).outcome, "tracked-held");
    x.fixture.versions = { "1.1.0": {} };
    const workflow = { path: ".github/workflows/" + name + ".yml", id: 21 };
    const completed = {
      id: 19,
      workflow_id: workflow.id,
      path: workflow.path,
      event,
      head_branch: "main",
      head_sha: base,
      repository: repo,
      head_repository: repo,
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
      actor,
      triggering_actor: actor,
    };
    x.fixture.ciWorkflow = workflow;
    x.fixture.ciRun = completed;
    const env = {
      GITHUB_REPOSITORY: d.REPOSITORY,
      GITHUB_ACTOR: actor.login,
      GITHUB_ACTOR_ID: String(actor.id),
      GITHUB_TRIGGERING_ACTOR: actor.login,
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: base,
      GITHUB_WORKFLOW_SHA: base,
      GITHUB_WORKFLOW_REF: `${d.REPOSITORY}/.github/workflows/factory-dependency-alerts.yml@refs/heads/main`,
    };
    const trigger = {
      env,
      event: { action: "completed", repository: repo, workflow, workflow_run: { ...completed } },
    };
    const now = new Date("2026-11-22T12:00:00Z");
    const { grant } = await x.ledger.update((state) =>
      policy.reserve(state, { ...context, ticket: 25, runId: "19" }, x.cfg, now)
    );
    assert.equal((await x.run(x.cfg, undefined, now)).outcome, "factory-busy");
    assert.deepEqual((await x.store.read()).state.deferred?.runs, ["19"]);
    assert.equal((await x.run(x.cfg, trigger, now)).outcome, "held-wake-not-due");
    await x.ledger.update((state) => ({
      state: policy.finish(state, grant.id, { status: "blocked" }, now),
    }));
    const before = (await x.ledger.read()).state;
    await assert.rejects(
      x.run(
        x.cfg,
        {
          ...trigger,
          event: {
            ...trigger.event,
            workflow_run: { ...completed, head_repository: { full_name: "foreign/repo" } },
          },
        },
        now
      ),
      /Untrusted held dependency completion/
    );
    x.fixture.ciRun = { ...completed, workflow_id: 20 };
    await assert.rejects(x.run(x.cfg, trigger, now), /Untrusted held dependency completion run/);
    x.fixture.ciRun = completed;
    assert.equal(
      (await x.run(x.cfg, trigger, new Date("2026-11-22T15:00:00Z"))).outcome,
      "held-wake-not-due"
    );
    assert.equal((await x.run(x.cfg, trigger, now)).outcome, "published");
    assert.equal((await x.run(x.cfg, trigger, now)).outcome, "held-wake-not-due");
    assert.equal(x.fixture.prPosts, 1);
    assert.equal(x.fixture.issuePosts, 1);
    assert.deepEqual((await x.ledger.read()).state, before);
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
  const now = new Date("2026-11-22T12:00:00Z");
  x.fixture.versions = { "2.0.0": {} };
  assert.equal((await x.run(x.cfg, undefined, now)).outcome, "tracked-held");
  x.fixture.versions = { "1.1.0": {} };
  assert.equal((await x.run(x.cfg, undefined, now)).outcome, "published");
  await x.reviewed();
  const mergeCommit = "f".repeat(40);
  await x.ledger.update((state) => {
    const ticket = state.tickets[9];
    ticket.merge = {
      status: "merged",
      head: ticket.head,
      pr: 9,
      at: now.toISOString(),
      runId: context.runId,
      runAttempt: 1,
      mergeCommit,
    };
    return { state };
  });
  x.fixture.main = mergeCommit;
  x.fixture.pr = { ...x.fixture.pr, state: "closed", merged: true, merge_commit_sha: mergeCommit };
  const pending = await x.run(x.cfg, undefined, now, true);
  assert.deepEqual(pending.heldProgress, { prepared: 1, merged: 1, cleared: 0 });
  assert.equal(x.fixture.issue.state, "open");
  x.fixture.alertCleared = true;
  await assert.rejects(x.run(), /lacks verified merge/);
  assert.equal(x.fixture.issue.state, "open");
  x.fixture.lockUpdated = true;
  const closed = await x.run({ ...x.cfg, daily: 0 }, undefined, now, true);
  assert.equal(closed.outcome, "daily-limit");
  assert.deepEqual(closed.heldProgress, { prepared: 1, merged: 1, cleared: 1 });
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
  assert.ok(workflow.on.schedule.length);
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: [
      "Factory CI",
      "Factory agents",
      "Automatic factory",
      "Dependency maintenance",
      "Proactive app discovery",
    ],
    branches: ["main"],
    types: ["completed"],
  });
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

test("a refreshed alert proposal uses verified Git ancestry when the PR API reports its old base", async () => {
  const x = await pipeline();
  assert.equal((await x.run()).outcome, "published");
  const oldBase = x.fixture.pr.base.sha;
  x.fixture.main = "f".repeat(40);
  assert.equal((await x.run()).outcome, "refreshed");
  assert.notEqual(oldBase, x.fixture.main);
  assert.equal(x.fixture.pr.base.sha, oldBase);
  x.fixture.cachedPrFiles = [{ filename: ".github/workflows/factory-ci.yml", status: "modified" }];

  const selected = await x.coordinator.select(false);
  assert.equal(selected.ready, true);
  assert.equal(selected.ticket, x.fixture.pr.number);
  const t = (await x.ledger.read()).state.tickets[selected.ticket];
  assert.equal(t.dependency.attempts.at(-1).base, x.fixture.main);
  await x.coordinator.controller.matchingPR(t);
});

test("a cached base cannot make a stale alert receipt current", async () => {
  const x = await pipeline();
  await x.run();
  x.fixture.main = "f".repeat(40);
  await x.run();
  x.fixture.liveMain = "e".repeat(40);
  assert.equal((await x.coordinator.select(false)).ready, false);
  assert.deepEqual((await x.ledger.read()).state.grants, {});
});
