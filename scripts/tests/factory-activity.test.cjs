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
        if(p.endsWith("/git/ref/heads/factory/state"))return {object:{sha}};
        if(p.includes("/contents/state.json"))return {type:"file",encoding:"base64",content:Buffer.from(JSON.stringify(require("../factory/policy.cjs").emptyState(repository))).toString("base64")};
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
    "stop",
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
test("concurrent observers report an unchanged stale interval once using the same verified monitor producer",async()=>{
 const s=setup(),base=s.api.request;
 const monitor={id:800,run_attempt:1,workflow_id:80,path:".github/workflows/factory-monitor.yml",head_sha:sha,head_branch:"main",status:"completed",conclusion:"success",updated_at:"2026-01-01T00:00:00.000Z",repository:{full_name:repository},head_repository:{full_name:repository},actor:{login:"haideearus",id:101267861},triggering_actor:{login:"haideearus",id:101267861}};
 s.api.request=(m,p,b)=>p.includes("/factory-monitor.yml/runs?")?Promise.resolve({workflow_runs:[monitor]}):p.endsWith("/actions/workflows/factory-monitor.yml")?Promise.resolve({id:80,path:monitor.path}):p.includes("/actions/runs/800/")?Promise.resolve(monitor):base(m,p,b);
 s.store.state.lastMonitor={runId:"800",at:monitor.updated_at};
 const {checkFreshness}=require("../factory/activity-observer.cjs");
 await Promise.all(["900","901"].map(runId=>checkFreshness({...s,context:{runId,runAttempt:1,workflowSha:sha,actor:"haideearus"}})));
 assert.equal(s.comments.length,1);assert.equal(s.store.state.staleFor,"800");
});
module.exports = { setup, producer };
