const assert = require("node:assert/strict");
const test = require("node:test");
const { verifyNativeFailure } = require("../factory/dependency-native-recovery.cjs");
const { ROOT } = require("../factory/github.cjs");
const { REPOSITORY } = require("../factory/policy.cjs");
const { canRequestNativeBranchUpdate } = require("../factory/dependency-tracking.cjs");

const head = "580ad5765e63a4380ca2a63b724d3cceca084cb9";
const ref = "dependabot/npm_and_yarn/faker-js/faker-10.5.0";
const actor = { login: "dependabot[bot]", id: 49699333, type: "Bot" };
const repo = { full_name: REPOSITORY };
const pr = {
  number: 232,
  state: "open",
  draft: false,
  user: actor,
  head: { sha: head, ref, repo },
  base: { sha: "12815b31fc33e2335f7f17fb1fdfd858b95ab51d", ref: "main", repo },
};
const candidate = {
  id: 46139647441,
  display_title: "Factory CI / 232",
  actor,
  path: ".github/workflows/factory-ci.yml",
  status: "completed",
  conclusion: "failure",
  event: "pull_request",
  head_sha: head,
  head_branch: ref,
  head_repository: { full_name: REPOSITORY },
  repository: { full_name: REPOSITORY },
  pull_requests: [{ number: pr.number }],
  run_attempt: 1,
};

test("only a completed exact native app CI failure permits compatibility coding", async () => {
  const calls = [];
  const fixture = (
    run,
    job = "app",
    step = "Run yarn types && yarn lint && yarn test:unit:ci"
  ) => ({
    async request(method, url) {
      calls.push([method, url]);
      if (url.includes("/workflows/factory-ci.yml/runs?")) return { workflow_runs: [run] };
      assert.equal(url, `${ROOT}/actions/runs/${candidate.id}/attempts/1/jobs?per_page=100`);
      return {
        jobs: [
          { name: "verify", status: "completed", conclusion: "failure" },
          {
            name: job,
            status: "completed",
            conclusion: "failure",
            steps: [{ name: step, conclusion: "failure" }],
          },
        ],
      };
    },
  });
  assert.equal(await verifyNativeFailure(fixture(candidate), pr), true);
  assert.equal(
    await verifyNativeFailure(fixture({ ...candidate, head_sha: "b".repeat(40) }), pr),
    false
  );
  assert.equal(
    await verifyNativeFailure(fixture({ ...candidate, pull_requests: [{ number: 4 }] }), pr),
    false
  );
  assert.equal(await verifyNativeFailure(fixture({ ...candidate, status: "queued" }), pr), false);
  assert.equal(
    await verifyNativeFailure(fixture({ ...candidate, actor: { ...actor, id: 12 } }), pr),
    false
  );
  assert.equal(
    await verifyNativeFailure(fixture({ ...candidate, display_title: "Factory CI / 233" }), pr),
    false
  );
  assert.equal(await verifyNativeFailure(fixture(candidate, "review"), pr), false);
  assert.equal(await verifyNativeFailure(fixture(candidate, "app", "Set up job"), pr), false);
  assert.ok(calls.every(([method]) => method === "GET"));
});

test("a stale native PR can get one App branch refresh after its normal rebase request", () => {
  const base = "b".repeat(40);
  const row = { status: "open", branch: ref, recovery: { [head]: { bases: {} } } };
  assert.equal(canRequestNativeBranchUpdate(row, pr, base), false);
  row.recovery[head].bases[base] = { refresh: "confirmed", stale: "requested" };
  assert.equal(canRequestNativeBranchUpdate(row, pr, base), true);
  assert.equal(
    canRequestNativeBranchUpdate(row, { ...pr, head: { ...pr.head, sha: base } }, base),
    false
  );
  row.recovery[head].bases[base].branchUpdate = true;
  assert.equal(canRequestNativeBranchUpdate(row, pr, base), false);
});
