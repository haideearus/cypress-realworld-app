const assert = require("node:assert/strict");
const { FactoryFixture, head } = require("./factory-fixtures.cjs");
const { GitHub, ROOT } = require("../../factory/github.cjs");
const policy = require("../../factory/policy.cjs");
const { emptyMonitorState, validateMonitorState } = require("../../factory/monitor-state.cjs");

const repo = { full_name: policy.REPOSITORY, url: `https://api.github.com${ROOT}` };
const owner = { login: policy.OWNER, type: "User", id: 101267861 };
const publisher = { login: "github-actions[bot]", type: "Bot", id: 41898282 };
const app = { login: "fixture-factory[bot]", type: "Bot" };
const automaticFile = ".github/workflows/factory-automatic.yml";
const functionalFile = ".github/workflows/factory-functional-discovery.yml";
const mergeSha = "c".repeat(40);

function run(id, path, workflow_id, conclusion = "success") {
  return {
    id,
    path,
    workflow_id,
    head_sha: head,
    head_branch: "main",
    repository: repo,
    head_repository: repo,
    event: "schedule",
    run_attempt: 1,
    actor: owner,
    triggering_actor: owner,
    status: "completed",
    conclusion,
  };
}

function m2Fixture() {
  const gh = new FactoryFixture();
  gh.issues.clear();
  const api = new GitHub({ token: "fixture-only", fetch: gh.fetch });
  const base = api.request.bind(api);
  const monitor = {
    state: emptyMonitorState(),
    async read() {
      return { state: structuredClone(this.state), commit: null };
    },
    async save(state) {
      this.state = structuredClone(validateMonitorState(state));
      return head;
    },
  };
  const result = { gh, api, monitor, calls: [], comments: [], receivers: new Map() };
  const changed = {
    filename: "src/components/UserSettingsForm.tsx",
    sha: "d".repeat(40),
    status: "modified",
  };
  const original = run(700, automaticFile, 70, "cancelled");
  const jobs = [
    ["coding / agent", "success"],
    ["publish", "success"],
    ["ci", "success"],
    ["reserve_review", "success"],
    ["review / agent", "cancelled"],
    ["assess", "skipped"],
  ].map(([name, conclusion]) => ({ name: `cycle1 / ${name}`, status: "completed", conclusion }));
  const browser = run(514, functionalFile, 50);
  const mainCi = { ...run(745, ".github/workflows/factory-ci.yml", 45), event: "push" };
  api.request = async (method, route, body) => {
    const url = new URL(`https://api.github.com${route}`);
    const path = url.pathname.slice(ROOT.length);
    result.calls.push({ method, path, body });
    if (path === "/issues" && method === "GET") return [...gh.issues.values()];
    if (path === "/issues" && method === "POST") {
      const issue = {
        ...body,
        labels: body.labels.map((name) => ({ name })),
        number: 10,
        state: "open",
        user: publisher,
        created_at: "2026-11-20T13:00:00Z",
      };
      assert.equal(gh.issues.has(10), false, "a second failure must not create another ticket");
      gh.issues.set(10, issue);
      return issue;
    }
    if (path === "/issues/10/comments") {
      if (method === "GET") return result.comments;
      assert.equal(method, "POST");
      const comment = { id: 500, user: publisher, ...body };
      result.comments.push(comment);
      return comment;
    }
    if (path === "/git/ref/heads/factory/monitor-functional") return { object: { sha: head } };
    if (path === "/contents/monitor.json")
      return {
        type: "file",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(monitor.state)).toString("base64"),
      };
    if (path === "/actions/workflows/factory-functional-discovery.yml")
      return { id: 50, path: functionalFile };
    if (path === "/actions/workflows/factory-automatic.yml") return { id: 70, path: automaticFile };
    if (path === "/actions/runs/514/attempts/1") return browser;
    if (path === "/actions/runs/514/attempts/1/jobs")
      return {
        jobs: [
          ["browser", "Run approved browser checks"],
          ["publish", "Publish confirmed functional failure"],
        ].map(([name, step]) => ({
          name,
          status: "completed",
          conclusion: "success",
          steps: [{ name: step, conclusion: "success" }],
        })),
      };
    if (path === "/actions/runs/700/attempts/1") return original;
    if (path === "/actions/runs/700/attempts/1/jobs") return { jobs };
    for (const [id, receiver] of result.receivers)
      if (path === `/actions/runs/${id}/attempts/1`) return structuredClone(receiver);
    if (
      path === "/actions/workflows/factory-ci.yml/runs" &&
      url.searchParams.get("event") === "push"
    )
      return { workflow_runs: [mainCi] };
    if (path === "/actions/runs/745/attempts/1/jobs")
      return {
        jobs: [{ name: "verify", head_sha: head, status: "completed", conclusion: "success" }],
      };
    if (path === "/git/ref/heads/main") return { object: { sha: gh.branchHeads.get("main") } };
    if (path.startsWith("/compare/"))
      return { behind_by: 0, merge_base_commit: { sha: head }, files: [changed] };
    if (path === "/pulls/20/files") return [changed];
    if (path === "/pulls/20/merge" && method === "PUT") {
      assert.equal(body.sha, gh.branchHeads.get("agent/factory-10"));
      assert.equal(body.merge_method, "squash");
      Object.assign(gh.prs[0], { state: "closed", merged: true, merge_commit_sha: mergeSha });
      gh.branchHeads.set("main", mergeSha);
      return { merged: true, sha: mergeSha };
    }
    if (["/pulls", "/pulls/20"].includes(path)) {
      const response = await base(method, route, body);
      if (Array.isArray(response)) return response;
      return {
        ...response,
        merged: response.merged ?? false,
        user: app,
        mergeable: true,
        mergeable_state: "clean",
        base: { ...response.base, repo },
      };
    }
    const prHead = gh.branchHeads.get("agent/factory-10");
    const association = {
      number: 20,
      url: `https://api.github.com${ROOT}/pulls/20`,
      head: { sha: prHead, ref: "agent/factory-10", repo },
      base: { ref: "main", repo },
    };
    const checks = ["verify", "Factory review gate"].map((name, index) => ({
      name,
      id: 900 + index,
      head_sha: prHead,
      status: "completed",
      conclusion: "success",
      app: { id: 15368 },
      check_suite: { id: 600 + index },
      pull_requests: [association],
      details_url: `https://github.com/${policy.REPOSITORY}/actions/runs/${610 + index}/job/${620 + index}`,
    }));
    if (path === `/commits/${prHead}/check-runs`) return { check_runs: checks };
    for (const [i, check] of checks.entries()) {
      const id = 610 + i;
      if (path === `/actions/runs/${id}`)
        return {
          ...run(
            id,
            `.github/workflows/${i ? "factory-review-status.yml" : "factory-ci.yml"}`,
            44 + i
          ),
          event: "pull_request",
          head_sha: prHead,
          head_branch: "agent/factory-10",
          check_suite_id: 600 + i,
          pull_requests: [association],
        };
      if (path === `/actions/runs/${id}/jobs`)
        return {
          jobs: [
            {
              name: check.name,
              id: 620 + i,
              run_id: id,
              status: "completed",
              conclusion: "success",
              check_run_url: `https://api.github.com${ROOT}/check-runs/${check.id}`,
            },
          ],
        };
    }
    return base(method, route, body);
  };
  return result;
}

module.exports = { m2Fixture, owner, mergeSha, repo };
