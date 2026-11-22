const test = require("node:test"),
  assert = require("node:assert/strict");
const { MemoryStore, repository, sha } = require("./helpers/event-fixtures.cjs");
let a;
try {
  a = require("../factory/activity.cjs");
} catch (e) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
}
const producer = {
  runId: "800",
  runAttempt: 1,
  workflow: "factory-automatic.yml",
  workflowSha: sha,
  phase: "pick",
  actor: "haideearus",
};
function setup() {
  const store = new MemoryStore({
    version: 1,
    repository,
    events: {},
    lastMonitor: null,
    staleFor: null,
    controlAfter: "2026-11-17T00:00:00.000Z",
  });
  const comments = [],
    calls = [];
  const s = {
    store,
    comments,
    calls,
    journalIssue: 100,
    scan: async () => ({ clean: true }),
    api: {
      async request(m, p, b) {
        calls.push({ m, p, b });
        if (p.endsWith("/git/ref/heads/factory/state")) return { object: { sha } };
        if (p.includes("/contents/state.json"))
          return {
            type: "file",
            encoding: "base64",
            content: Buffer.from(
              JSON.stringify(require("../factory/policy.cjs").emptyState(repository))
            ).toString("base64"),
          };
        if (p.endsWith("/issues/100") && m === "GET")
          return {
            number: 100,
            state: "open",
            labels: [],
            user: { login: "haideearus", id: 101267861 },
          };
        if (p.includes("/actions/workflows/"))
          return { id: 80, path: ".github/workflows/factory-automatic.yml" };
        if (p.includes("/actions/runs/800/"))
          return {
            id: 800,
            run_attempt: 1,
            workflow_id: 80,
            path: ".github/workflows/factory-automatic.yml",
            head_sha: sha,
            head_branch: "main",
            event: "schedule",
            repository: { full_name: repository },
            head_repository: { full_name: repository },
            actor: { login: "haideearus", id: 101267861 },
            triggering_actor: { login: "haideearus", id: 101267861 },
          };
        if (p.includes("/comments") && m === "GET") return comments;
        if (p.endsWith("/comments") && m === "POST") {
          comments.push({
            id: 123,
            body: b.body,
            user: { login: "github-actions[bot]", id: 41898282 },
          });
          if (s.uncertain) throw Error("uncertain");
          return comments.at(-1);
        }
        throw Error("Unexpected activity route " + p);
      },
    },
  };
  return s;
}
test("activity publisher exists", () => assert.ok(a));
test("each lifecycle kind is typed and duplicate publication sends one bounded journal entry", async () => {
  for (const kind of [
    "issue",
    "monitor",
    "queue",
    "coding",
    "review",
    "discovery",
    "ci",
    "merge",
    "deployment",
    "budget",
    "monitor-stale",
    "monitor-recovered",
  ]) {
    const s = setup();
    const event = a.buildActivityEvent({
      producer,
      kind,
      state: "completed",
      subject: 12,
      head: sha,
      summary: "Trusted phase completed",
      links: [`https://github.com/${repository}/actions/runs/800`],
    });
    await a.publishActivity({ ...s, event });
    await a.publishActivity({ ...s, event });
    assert.equal(s.comments.length, 1);
    assert.match(s.comments[0].body, /factory-activity:/);
    assert.equal(Object.values(s.store.state.events)[0].status, "published");
  }
});
test("comment committed before response loss is reconciled without posting again", async () => {
  const s = setup();
  s.uncertain = true;
  const event = a.buildActivityEvent({
    producer,
    kind: "queue",
    state: "held",
    subject: 12,
    head: sha,
    summary: "Capacity held",
    links: [],
  });
  assert.equal((await a.publishActivity({ ...s, event })).outcome, "uncertain");
  assert.equal((await a.publishActivity({ ...s, event })).outcome, "reconciled");
  assert.equal(s.comments.length, 1);
});
test("unknown publication remains held when lookup cannot prove a committed comment", async () => {
  const s = setup();
  const event = a.buildActivityEvent({
    producer,
    kind: "review",
    state: "held",
    subject: 12,
    head: sha,
    summary: "Review blocked",
    links: [],
  });
  s.store.state.events[event.id] = { event, status: "intent", commentId: null };
  assert.equal((await a.publishActivity({ ...s, event })).outcome, "uncertain");
  assert.equal(s.comments.length, 0);
});
test("secret-bearing data, arbitrary links and oversized reports are rejected before POST", () => {
  for (const changes of [
    { summary: "Bearer abcdefghijklmnopqrstuvwxyz" },
    { summary: "x".repeat(2001) },
    { links: ["https://evil.invalid/"] },
    { summary: "@someone do this" },
    { producer: { ...producer, workflow: "attacker.yml" } },
  ])
    assert.throws(() =>
      a.buildActivityEvent({
        producer,
        kind: "queue",
        state: "held",
        subject: 12,
        head: sha,
        summary: "Held",
        links: [],
        ...changes,
      })
    );
});
test("journal cannot be a factory-ready ticket and forged run producers never publish", async () => {
  for (const mode of ["label", "producer"]) {
    const s = setup(),
      base = s.api.request;
    s.api.request = async (m, p, b) =>
      mode === "label" && p.endsWith("/issues/100")
        ? {
            number: 100,
            state: "open",
            labels: [{ name: "factory-ready" }],
            user: { login: "haideearus", id: 101267861 },
          }
        : mode === "producer" && p.includes("/actions/runs/800/")
          ? { id: 999 }
          : base(m, p, b);
    const event = a.buildActivityEvent({
      producer,
      kind: "queue",
      state: "held",
      subject: 12,
      head: sha,
      summary: "Held",
      links: [],
    });
    await assert.rejects(a.publishActivity({ ...s, event }));
    assert.equal(s.comments.length, 0);
  }
});
test("90-minute monitor staleness is deduplicated and later verified recovery is reported", () => {
  const state = { lastMonitor: { runId: "80", at: "2026-11-17T10:00:00.000Z" }, staleFor: null };
  assert.equal(a.monitorFreshness(state, new Date("2026-11-17T11:29:59Z")), null);
  assert.equal(a.monitorFreshness(state, new Date("2026-11-17T11:30:00Z")), "monitor-stale");
  assert.equal(a.monitorFreshness(state, new Date("2026-11-17T12:00:00Z")), null);
  assert.equal(
    a.monitorFreshness(state, new Date("2026-11-17T12:01:00Z"), {
      runId: "81",
      at: "2026-11-17T12:00:30.000Z",
    }),
    "monitor-recovered"
  );
});
test("a newer but already stale completion cannot be called monitoring recovery", () => {
  const state = { lastMonitor: { runId: "80", at: "2026-11-17T09:00:00.000Z" }, staleFor: "80" };
  assert.equal(
    a.monitorFreshness(state, new Date("2026-11-17T12:00:00Z"), {
      runId: "81",
      at: "2026-11-17T09:05:00.000Z",
    }),
    "monitor-stale"
  );
});
test("concurrent observers report an unchanged stale interval once using the same verified monitor producer", async () => {
  const s = setup(),
    base = s.api.request;
  const monitor = {
    id: 800,
    run_attempt: 1,
    workflow_id: 80,
    path: ".github/workflows/factory-monitor.yml",
    head_sha: sha,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    updated_at: "2026-01-01T00:00:00.000Z",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    actor: { login: "haideearus", id: 101267861 },
    triggering_actor: { login: "haideearus", id: 101267861 },
  };
  s.api.request = (m, p, b) =>
    p.includes("/factory-monitor.yml/runs?")
      ? Promise.resolve({ workflow_runs: [monitor] })
      : p.endsWith("/actions/workflows/factory-monitor.yml")
        ? Promise.resolve({ id: 80, path: monitor.path })
        : p.includes("/actions/runs/800/")
          ? Promise.resolve(monitor)
          : base(m, p, b);
  s.store.state.lastMonitor = { runId: "800", at: monitor.updated_at };
  const { checkFreshness } = require("../factory/activity-observer.cjs");
  await Promise.all(
    ["900", "901"].map((runId) =>
      checkFreshness({
        ...s,
        context: { runId, runAttempt: 1, workflowSha: sha, actor: "haideearus" },
      })
    )
  );
  assert.equal(s.comments.length, 1);
  assert.equal(s.store.state.staleFor, "800");
});
module.exports = { setup, producer };
test("idle stop and resume are recovered from durable command history once, with unresolved results retained", () => {
  const { controlEvents } = require("../factory/activity-controls.cjs");
  const id = "12345678-1234-4123-8123-123456789abc";
  const state = require("../factory/policy.cjs").emptyState(repository);
  state.audit = [
    {
      event: "factory-stop-requested",
      actor: "haideearus",
      commandId: id,
      at: "2026-11-17T10:00:00.000Z",
    },
    {
      event: "factory-stop-result",
      actor: "haideearus",
      commandId: id,
      at: "2026-11-17T10:00:10.000Z",
      switchesOff: true,
      inventoryComplete: true,
      pendingRunIds: [123],
      terminalRunIds: [],
      elapsedMs: 10000,
    },
    {
      event: "factory-resumed",
      actor: "haideearus",
      commandId: id,
      at: "2026-11-17T10:05:00.000Z",
    },
  ];
  const first = controlEvents({ state, commit: sha }, producer, "2026-11-17T09:00:00.000Z");
  const second = controlEvents(
    { state, commit: "b".repeat(40) },
    { ...producer, runId: "801" },
    "2026-11-17T09:00:00.000Z"
  );
  assert.equal(first.length, 3);
  assert.deepEqual(
    first.map((e) => e.id),
    second.map((e) => e.id)
  );
  assert.equal(first[1].state, "held");
  assert.match(first[1].summary, /123/);
  assert.equal(state.stop, undefined);
  assert.equal(
    controlEvents({ state, commit: sha }, producer, "2026-11-17T10:06:00.000Z").length,
    0
  );
});
test("a stop journal entry must match an ancestral command snapshot and cannot fabricate a successful result", async () => {
  const s = setup(),
    base = s.api.request,
    state = require("../factory/policy.cjs").emptyState(repository);
  state.audit = [
    {
      event: "factory-stop-result",
      actor: "haideearus",
      commandId: "12345678-1234-4123-8123-123456789abc",
      at: "2026-11-17T10:00:00.000Z",
      pendingRunIds: [123],
      switchesOff: true,
      inventoryComplete: true,
      elapsedMs: 1000,
    },
  ];
  s.api.request = (m, p, b) =>
    p.includes("/contents/state.json")
      ? Promise.resolve({
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(state)).toString("base64"),
        })
      : base(m, p, b);
  const event = require("../factory/activity-controls.cjs").controlEvents(
    { state, commit: sha },
    producer,
    "2026-11-17T09:00:00.000Z"
  )[0];
  await assert.rejects(
    a.publishActivity({ ...s, event: { ...event, state: "completed" } }),
    /command history/
  );
  assert.equal(s.comments.length, 0);
  await a.publishActivity({ ...s, event });
  await a.publishActivity({ ...s, event });
  assert.equal(s.comments.length, 1);
  const saved = s.api.request;
  s.api.request = (m, p, b) =>
    p.endsWith("/git/ref/heads/factory/state")
      ? Promise.resolve({ object: { sha: "b".repeat(40) } })
      : p.includes("/compare/")
        ? Promise.resolve({ merge_base_commit: { sha: "c".repeat(40) }, behind_by: 1 })
        : saved(m, p, b);
  await assert.rejects(a.verifyActivityProducer(s.api, event), /ancestry/);
});

async function useGitActivityStore(s, seed = s.store.state) {
  const { ActivityStore } = require("../factory/activity-store.cjs");
  const { MetadataStore } = require("../factory/metadata-store.cjs");
  const { MetadataFixture } = require("./helpers/metadata-fixture.cjs");
  const git = new MetadataFixture();
  const legacy = new MetadataStore(git, "activity", a.emptyActivity, a.validateActivity);
  const initial = await legacy.save(seed, null);
  const request = s.api.request;
  let conflicts = 0;
  s.api.request = async (method, resource, body) => {
    if (
      /\/git\/(?:commits|blobs|trees|refs)(?:\/|$)|\/git\/ref\/heads\/factory\/activity$/.test(
        resource
      ) ||
      /\/contents\/(?:activity\.json|published\/)/.test(resource)
    ) {
      try {
        return await git.request(method, resource, body);
      } catch (error) {
        if (error.status === 422) conflicts++;
        throw error;
      }
    }
    return request(method, resource, body);
  };
  s.store = new ActivityStore(s.api);
  const at = async (path, commit) => {
    const file = await git.request("GET", `/repos/${repository}/contents/${path}?ref=${commit}`);
    return JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  };
  return {
    original: (path) => at(path, initial),
    current: (path) => at(path, git.refs.get("factory/activity")),
    conflicts: () => conflicts,
  };
}

function journalEvent(subject, changes = {}) {
  return a.buildActivityEvent({
    producer,
    kind: "queue",
    state: "completed",
    subject,
    head: sha,
    summary: "Trusted queue event completed",
    ...changes,
  });
}

test("the real activity store migrates a near-full journal and keeps archive lookups after later saves", async () => {
  const s = setup();
  const seed = s.store.state;
  const unresolved = journalEvent(10);
  seed.events[unresolved.id] = { event: unresolved, status: "intent", commentId: null };
  const replay = journalEvent(11);
  seed.events[replay.id] = { event: replay, status: "published", commentId: 42 };
  let subject = 100;
  while (Buffer.byteLength(JSON.stringify(seed, null, 2)) < 999000) {
    const event = journalEvent(subject++, { summary: "e".repeat(430) });
    seed.events[event.id] = { event, status: "published", commentId: subject };
  }
  assert.ok(Buffer.byteLength(JSON.stringify(seed, null, 2)) < 1000000);
  const git = await useGitActivityStore(s);
  const next = journalEvent(12, { summary: "n".repeat(1800) });

  assert.equal((await a.publishActivity({ ...s, event: next })).outcome, "published");
  assert.equal((await a.publishActivity({ ...s, event: journalEvent(13) })).outcome, "published");
  assert.deepEqual(await a.publishActivity({ ...s, event: replay }), {
    outcome: "duplicate",
    commentId: 42,
  });
  const { state } = await s.store.read();
  assert.equal(state.version, 2);
  assert.deepEqual(Object.keys(state.events), [unresolved.id]);
  assert.equal(state.events[unresolved.id].status, "intent");
  assert.equal(s.comments.length, 2);
  assert.equal((await git.original("activity.json")).events[replay.id].commentId, 42);
  assert.deepEqual(
    await git.current("published/" + replay.id.slice(0, 2) + "/" + replay.id + ".json"),
    { id: replay.id, commentId: 42 }
  );
});

test("overlapping real activity claims make one comment and preserve distinct receipts through CAS", async () => {
  const s = setup();
  const git = await useGitActivityStore(s);
  const first = journalEvent(11);
  const second = journalEvent(12);
  await Promise.all([
    a.publishActivity({ ...s, event: first }),
    a.publishActivity({ ...s, event: first }),
    a.publishActivity({ ...s, event: second }),
  ]);
  assert.ok(git.conflicts() > 0, "fixture must exercise the real CAS retry");
  assert.equal(s.comments.length, 2);
  assert.equal((await a.publishActivity({ ...s, event: first })).outcome, "duplicate");
  assert.equal((await a.publishActivity({ ...s, event: second })).outcome, "duplicate");
  assert.equal(s.comments.length, 2);
});

test("a lost comment response can be reconciled beyond the old thousand-comment limit", async () => {
  const s = setup();
  const event = journalEvent(10);
  s.store.state.events[event.id] = { event, status: "intent", commentId: null };
  const request = s.api.request;
  s.api.request = async (method, path, body) => {
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1]);
    if (method === "GET" && path.includes("/comments?")) {
      if (page <= 10) return Array.from({ length: 100 }, () => ({ body: "Older unrelated event" }));
      return [
        {
          id: 1200,
          body: a.renderEvent(event),
          user: { login: "github-actions[bot]", id: 41898282 },
        },
      ];
    }
    return request(method, path, body);
  };
  assert.deepEqual(await a.publishActivity({ ...s, event }), {
    outcome: "reconciled",
    commentId: 1200,
  });
  assert.equal(s.comments.length, 0);
});

test("an incomplete journal search preserves the intent without a second comment or reporter failure", async () => {
  const s = setup();
  const event = journalEvent(10);
  s.store.state.events[event.id] = { event, status: "intent", commentId: null };
  const request = s.api.request;
  let reads = 0;
  s.api.request = async (method, path, body) => {
    if (method === "GET" && path.includes("/comments?")) {
      reads++;
      return Array.from({ length: 100 }, () => ({ body: "Unrelated receipt" }));
    }
    return request(method, path, body);
  };
  assert.deepEqual(await a.publishActivity({ ...s, event }), { outcome: "uncertain" });
  assert.equal(reads, 20);
  assert.equal(s.store.state.events[event.id].status, "intent");
  assert.equal(s.comments.length, 0);
});
