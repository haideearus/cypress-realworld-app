const test = require("node:test");
const assert = require("node:assert/strict");
const { monitor, observeIncident } = require("../factory/monitor.cjs");
const { MonitorStore, emptyMonitorState } = require("../factory/monitor-state.cjs");
const { ROOT } = require("../factory/github.cjs");

const sha = "a".repeat(40);
const context = {
  repository: "haideearus/cypress-realworld-app",
  ref: "refs/heads/main",
  workflowRef:
    "haideearus/cypress-realworld-app/.github/workflows/factory-monitor-drill.yml@refs/heads/main",
  workflowSha: sha,
  sha,
  runId: "350",
  runAttempt: 1,
  eventName: "workflow_dispatch",
  actor: "haideearus",
  triggeringActor: "haideearus",
};
const failed = {
  healthy: false,
  checks: { health: "ok", readiness: "failed", frontend: "ok" },
  attempts: 3,
};
const healthy = {
  healthy: true,
  checks: { health: "ok", readiness: "ok", frontend: "ok" },
  attempts: 1,
};

function fixture() {
  const calls = [];
  const refs = new Map();
  const objects = new Map();
  const issues = new Map();
  let sequence = 0;
  let refWrites = 0;
  const f = { calls, refs, issues, ambiguousPost: false, unacknowledgedWrite: 0 };
  const api = {
    async request(method, path, body) {
      assert.ok(path.startsWith(ROOT));
      const route = path.slice(ROOT.length);
      calls.push({ method, route, body: structuredClone(body) });
      if (method === "GET" && route.startsWith("/git/ref/heads/")) {
        const commit = refs.get(route.slice("/git/ref/heads/".length));
        if (!commit) throw Object.assign(new Error("Missing registry"), { status: 404 });
        return { object: { sha: commit } };
      }
      if (method === "GET" && route.startsWith("/contents/monitor.json?ref=")) {
        const commit = objects.get(route.split("?ref=")[1]);
        const tree = objects.get(commit.tree);
        assert.deepEqual(
          tree.tree.map((entry) => entry.path),
          ["monitor.json"]
        );
        const blob = objects.get(tree.tree[0].sha);
        return { type: "file", encoding: "base64", content: blob.content };
      }
      if (method === "POST" && ["/git/blobs", "/git/trees", "/git/commits"].includes(route)) {
        const objectSha = String(++sequence).padStart(40, "0");
        objects.set(objectSha, structuredClone(body));
        return { sha: objectSha };
      }
      if (route === "/git/refs" || route.startsWith("/git/refs/heads/")) {
        const branch =
          method === "POST"
            ? body.ref.slice("refs/heads/".length)
            : route.slice("/git/refs/heads/".length);
        const commit = objects.get(body.sha);
        if (method === "PATCH") {
          assert.equal(body.force, false);
          assert.deepEqual(commit.parents, [refs.get(branch)]);
        } else {
          assert.equal(method, "POST");
          assert.equal(refs.has(branch), false);
          assert.deepEqual(commit.parents, []);
        }
        if (++refWrites === f.unacknowledgedWrite) return { object: { sha } };
        refs.set(branch, body.sha);
        return { object: { sha: body.sha } };
      }
      if (method === "POST" && route === "/issues") {
        const issue = {
          ...structuredClone(body),
          number: issues.size + 50,
          state: "open",
          user: { login: "github-actions[bot]", type: "Bot" },
        };
        issues.set(issue.number, issue);
        if (f.ambiguousPost) throw new Error("Ambiguous issue publication");
        return structuredClone(issue);
      }
      if (method === "GET" && /^\/issues\/\d+$/.test(route))
        return structuredClone(issues.get(Number(route.split("/").at(-1))));
      throw new Error(`Unexpected request: ${method} ${route}`);
    },
  };
  const store = new MonitorStore(api, "drill");
  return Object.assign(f, {
    api,
    store,
    options: {
      api,
      store,
      context,
      observation: failed,
      now: () => "2026-11-14T12:00:00.000Z",
      issueText: (incident) => ({
        title: "[DRILL] Repair the isolated readiness fixture",
        body: `Synthetic incident ${incident.id}; source run ${incident.source.runId}.`,
      }),
      labels: ["factory-drill"],
    },
  });
}

test("monitor namespaces reject arbitrary branch targets before any request", () => {
  const f = fixture();
  for (const namespace of ["", "factory/monitor", "other", "__proto__", null, {}, ["drill"]])
    assert.throws(() => new MonitorStore(f.api, namespace), /namespace/i);
  assert.deepEqual(f.calls, []);
});

test("fixed monitor namespaces read and write isolated refs with the same registry file", async () => {
  const f = fixture();
  for (const [namespace, branch] of [
    [undefined, "factory/monitor"],
    ["production", "factory/monitor"],
    ["drill", "factory/monitor-drill"],
  ]) {
    const store = new MonitorStore(f.api, namespace);
    const before = await store.read();
    const commit = await store.save(before.state, before.commit);
    assert.equal(f.refs.get(branch), commit);
    assert.deepEqual(await store.read(), { state: emptyMonitorState(), commit });
    assert.ok(f.calls.some((call) => call.route === `/git/ref/heads/${branch}`));
  }
  assert.deepEqual([...f.refs.keys()], ["factory/monitor", "factory/monitor-drill"]);
});

test("shared drill publication stores its actual source, custom text and separate label", async () => {
  const f = fixture();
  assert.equal(typeof observeIncident, "function");
  const result = await observeIncident(f.options);
  assert.equal(result.outcome, "incident_created");
  const issue = f.issues.get(result.issue);
  assert.equal(issue.title, "[DRILL] Repair the isolated readiness fixture");
  assert.deepEqual(issue.labels, ["factory-drill"]);
  const { state } = await f.store.read();
  assert.deepEqual(state.incidents[state.active].source, {
    runId: "350",
    runAttempt: 1,
    workflowSha: sha,
  });
  assert.deepEqual(await new MonitorStore(f.api).read(), {
    state: emptyMonitorState(),
    commit: null,
  });
  const publication = f.calls.findIndex((call) => call.route === "/issues");
  assert.ok(f.calls.slice(0, publication).some((call) => call.route === "/git/refs"));
});

test("shared transition retains the production issue text and queue label by default", async () => {
  const f = fixture();
  assert.equal(typeof observeIncident, "function");
  const result = await observeIncident({
    ...f.options,
    store: new MonitorStore(f.api),
    issueText: undefined,
    labels: undefined,
  });
  const issue = f.issues.get(result.issue);
  assert.equal(issue.title, "Production monitor: investigate failed public checks");
  assert.deepEqual(issue.labels, ["factory-ready"]);
  assert.deepEqual([...f.refs.keys()], ["factory/monitor"]);
});

test("shared observations deduplicate failure and retain active recovery until its exact issue closes", async () => {
  const f = fixture();
  assert.equal(typeof observeIncident, "function");
  const first = await observeIncident(f.options);
  const repeated = await observeIncident(f.options);
  assert.equal(repeated.outcome, "incident_existing");
  assert.equal(repeated.issue, first.issue);
  assert.equal(f.issues.size, 1);
  assert.equal(
    (await observeIncident({ ...f.options, observation: healthy })).outcome,
    "recovered"
  );
  assert.notEqual((await f.store.read()).state.active, null);
  f.issues.get(first.issue).state = "closed";
  await observeIncident({ ...f.options, observation: healthy });
  const { state } = await f.store.read();
  assert.equal(state.active, null);
  assert.equal(Object.values(state.incidents)[0].recovered, true);
  assert.equal(Object.keys(state.incidents).length, 1);
  assert.equal(
    f.calls.some((call) => call.method === "PATCH" && call.route.startsWith("/issues/")),
    false
  );
});

test("ambiguous shared publication persists intent and never retries the issue POST", async () => {
  const f = fixture();
  assert.equal(typeof observeIncident, "function");
  f.ambiguousPost = true;
  await assert.rejects(observeIncident(f.options), /Ambiguous issue publication/);
  const { state } = await f.store.read();
  assert.equal(state.incidents[state.active].phase, "pending");
  assert.equal((await observeIncident(f.options)).outcome, "publication_needs_owner_recovery");
  assert.equal(
    f.calls.filter((call) => call.method === "POST" && call.route === "/issues").length,
    1
  );
});

test("an unacknowledged publication receipt cannot cause a second issue POST", async () => {
  const f = fixture();
  assert.equal(typeof observeIncident, "function");
  f.unacknowledgedWrite = 2;
  await assert.rejects(observeIncident(f.options), /not acknowledged/);
  assert.equal((await observeIncident(f.options)).outcome, "publication_needs_owner_recovery");
  assert.equal(f.issues.size, 1);
});

test("invalid shared observations and clocks fail before reading or mutating state", async () => {
  const f = fixture();
  assert.equal(typeof observeIncident, "function");
  for (const observation of [
    null,
    { ...failed, healthy: true },
    { ...failed, attempts: 4 },
    { ...failed, checks: { ...failed.checks, external: "ok" } },
    { ...failed, release: "main" },
  ])
    await assert.rejects(
      observeIncident({ ...f.options, observation }),
      /Invalid monitor observation/
    );
  await assert.rejects(observeIncident({ ...f.options, now: () => "bad" }), /Invalid monitor time/);
  assert.deepEqual(f.calls, []);
});

test("production preview writes nothing and the production guard rejects actual drill context", async () => {
  const f = fixture();
  let probes = 0;
  const options = {
    ...f.options,
    enabled: true,
    dryRun: true,
    probe: async () => {
      probes++;
      return failed;
    },
  };
  await assert.rejects(monitor(options), /Untrusted monitor context/);
  assert.equal(probes, 0);
  const result = await monitor({
    ...options,
    context: {
      ...context,
      workflowRef:
        "haideearus/cypress-realworld-app/.github/workflows/factory-monitor.yml@refs/heads/main",
    },
  });
  assert.equal(result.outcome, "preview");
  assert.equal(probes, 1);
  assert.deepEqual(f.calls, []);
});
