const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const policy = require("../../factory/policy.cjs");
const { ROOT } = require("../../factory/github.cjs");
const { validateMonitorState } = require("../../factory/monitor-state.cjs");
const at = "2026-11-16T08:00:00.000Z",
  sha = "a".repeat(40);
function fixture() {
  const context = {
    repository: policy.REPOSITORY,
    actor: policy.OWNER,
    triggeringActor: policy.OWNER,
    ref: "refs/heads/main",
    eventName: "workflow_dispatch",
    workflowRef: `${policy.REPOSITORY}/.github/workflows/factory-monitor-acknowledge.yml@refs/heads/main`,
    workflowSha: sha,
    sha,
    runId: "900",
    runAttempt: 1,
  };
  const settings = {
    FACTORY_ENABLED: "false",
    FACTORY_AUTOMATION_ENABLED: "false",
    FACTORY_AUTOMERGE_ENABLED: "false",
    FACTORY_APP_CHECKS_ENABLED: "true",
  };
  const issue = {
    number: 65,
    title: "Monitor incident",
    body: "Frozen criteria",
    state: "open",
    user: { login: "github-actions[bot]", type: "Bot" },
  };
  const incident = {
    id: "12345678-1234-4123-8123-123456789012",
    issue: 65,
    at,
    day: at.slice(0, 10),
    phase: "open",
    recovered: false,
    criteriaHash: createHash("sha256")
      .update(JSON.stringify([issue.title, issue.body]))
      .digest("hex"),
    source: { runId: "700", runAttempt: 1, workflowSha: sha },
  };
  const registry = {
    version: 1,
    repository: policy.REPOSITORY,
    active: incident.id,
    incidents: { [incident.id]: incident },
  };
  const state = policy.emptyState(policy.REPOSITORY);
  state.stop = {
    id: "22222222-2222-4222-8222-222222222222",
    actor: policy.OWNER,
    at,
    reason: "Owner emergency stop",
    previous: Object.fromEntries(
      Object.keys(settings)
        .filter((k) => k !== "FACTORY_APP_CHECKS_ENABLED")
        .map((k) => [k, "false"])
    ),
  };
  const report = {
    version: 1,
    kind: "standard-recovery-observation",
    repository: policy.REPOSITORY,
    runId: context.runId,
    runAttempt: 1,
    workflowSha: sha,
    at,
    result: {
      healthy: true,
      checks: { login: "ok", session: "ok", feed: "ok", logout: "ok" },
      attempts: 1,
      releases: { before: sha, after: sha },
    },
  };
  const observation = {
    healthy: true,
    checks: { health: "ok", readiness: "ok", frontend: "ok" },
    attempts: 1,
    release: sha,
  };
  const f = {
    context,
    settings,
    issue,
    incident,
    registry,
    state,
    report,
    observation,
    calls: [],
    failClose: false,
    failFinal: false,
    afterIntent: null,
    beforeFinal: null,
    commit: "b".repeat(40),
    now: () => at,
  };
  f.store = {
    read: async () => ({ state: structuredClone(registry), commit: f.commit }),
    save: async (next, parent) => {
      assert.equal(parent, f.commit);
      validateMonitorState(next);
      f.calls.push({ method: "SAVE", phase: next.incidents[incident.id].acknowledgment?.phase });
      if (f.failFinal && next.active === null) throw Error("lost final response");
      Object.assign(registry, structuredClone(next));
      f.commit = createHash("sha1").update(f.commit).digest("hex");
      if (next.active && f.afterIntent) f.afterIntent(f);
      return f.commit;
    },
  };
  f.ledger = { read: async () => ({ state: structuredClone(state), commit: "c".repeat(40) }) };
  f.api = {
    request: async (method, url, body) => {
      const p = new URL("https://api.github.com" + url).pathname.slice(ROOT.length);
      f.calls.push({ method, path: p, body });
      if (method === "PATCH" && p === "/issues/65") {
        Object.assign(issue, body);
        if (f.failClose) throw Error("lost close response");
        return structuredClone(issue);
      }
      assert.equal(method, "GET", "only the exact issue may be mutated");
      if (p === "/issues/65") return structuredClone(issue);
      if (p === "/git/ref/heads/factory/monitor") return { object: { sha: f.commit } };
      if (p === "/contents/monitor.json")
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(registry)).toString("base64"),
        };
      if (p === "/actions/workflows/factory-monitor.yml")
        return { id: 10, path: ".github/workflows/factory-monitor.yml" };
      if (p === "/actions/runs/700/attempts/1")
        return {
          id: 700,
          workflow_id: 10,
          path: ".github/workflows/factory-monitor.yml",
          head_sha: sha,
          head_branch: "main",
          repository: { full_name: policy.REPOSITORY },
          head_repository: { full_name: policy.REPOSITORY },
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
          event: "schedule",
          actor: { login: policy.OWNER },
          triggering_actor: { login: policy.OWNER },
        };
      if (p === "/actions/runs/700/attempts/1/jobs")
        return {
          total_count: 1,
          jobs: [
            {
              name: "monitor",
              status: "completed",
              conclusion: "success",
              steps: [{ name: "Observe production and publish incident", conclusion: "success" }],
            },
          ],
        };
      throw Error("Unexpected fixture request " + p);
    },
  };
  f.options = () => ({
    api: f.api,
    context: f.context,
    settings: f.settings,
    issueNumber: 65,
    report: f.report,
    store: f.store,
    ledger: f.ledger,
    probe: async () => f.observation,
    now: f.now,
  });
  return f;
}
module.exports = { fixture, at, sha };
