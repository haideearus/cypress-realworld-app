const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const policy = require("../factory/policy.cjs");
const { context, vars } = require("./helpers/factory-fixtures.cjs");
const evidence = require("../../docs/factory/evidence/stale-run-43467058965/evidence.json");
const ROOT = `/repos/${policy.REPOSITORY}`;
function fixture() {
  const state = policy.emptyState(policy.REPOSITORY);
  state.tickets[38] = structuredClone(evidence.sentinel.ticket);
  state.grants = structuredClone(evidence.sentinel.grants);
  state.days["2026-11-14"] = [38];
  policy.validateState(state);
  const facts = structuredClone(evidence);
  const run = {
    ...facts.run,
    repository: { full_name: policy.REPOSITORY },
    actor: { login: policy.OWNER },
    triggering_actor: { login: policy.OWNER },
  };
  const api = {
    async request(method, url) {
      assert.equal(method, "GET");
      if (url === `${ROOT}/actions/runs/${run.id}`) return structuredClone(run);
      if (url.endsWith("/jobs?filter=all&per_page=100")) return facts.jobs;
      if (url.endsWith("/artifacts?per_page=100")) return facts.artifacts;
      if (url.endsWith("/pending_deployments")) return facts.pendingDeployments;
      if (url.endsWith(`/check-suites/${run.check_suite_id}`)) return facts.checkSuite;
      if (url.endsWith("/check-runs?per_page=100")) return facts.checkRuns;
      throw Error("Unexpected read");
    },
  };
  return { state, facts, run, api };
}
test("only the pinned empty queued run with retained genuine containment is eligible", async () => {
  const { inspectQuarantine } = require("../factory/quarantine.cjs");
  const f = fixture();
  const result = await inspectQuarantine(f.api, f.state, f.run);
  assert.equal(result.id, evidence.run.id);
  assert.equal(result.status, "queued");
  assert.equal(result.containmentTicket, 38);
  for (const change of [
    (r) => r.id++,
    (r) => r.run_attempt++,
    (r) => r.workflow_id++,
    (r) => (r.head_sha = "f".repeat(40)),
    (r) => (r.status = "in_progress"),
    (r) => (r.conclusion = "cancelled"),
    (r) => (r.path = ".github/workflows/factory-agents.yml"),
    (r) => (r.repository.full_name = "other/repo"),
    (r) => (r.head_branch = "other"),
    (r) => (r.event = "schedule"),
    (r) => (r.actor.login = "other"),
    (r) => (r.triggering_actor.login = "other"),
    (r) => (r.updated_at = "2026-11-14T01:00:00Z"),
    (r) => (r.created_at = null),
    (r) => (r.run_started_at = null),
    (r) => r.check_suite_id++,
    (r) => (r.referenced_workflows = []),
  ]) {
    const g = fixture();
    change(g.run);
    assert.equal(await inspectQuarantine(g.api, g.state, g.run), null);
  }
});
test("nonempty, missing or inconsistent provider collections and outages never grant quarantine", async () => {
  const { inspectQuarantine } = require("../factory/quarantine.cjs");
  for (const change of [
    (f) => f.facts.jobs.total_count++,
    (f) => f.facts.jobs.jobs.push({ id: 1 }),
    (f) => delete f.facts.jobs.total_count,
    (f) => f.facts.checkRuns.check_runs.push({ id: 1 }),
    (f) => f.facts.checkRuns.total_count++,
    (f) => f.facts.artifacts.artifacts.push({ id: 1 }),
    (f) => f.facts.artifacts.total_count++,
    (f) => f.facts.pendingDeployments.push({ id: 1 }),
    (f) => (f.facts.pendingDeployments = null),
    (f) => f.facts.checkSuite.app.id++,
    (f) => (f.facts.checkSuite.status = "in_progress"),
    (f) => (f.facts.checkSuite.head_sha = "b".repeat(40)),
    (f) => (f.facts.checkSuite.repository.full_name = "other/repo"),
    (f) => f.facts.checkSuite.latest_check_runs_count++,
    (f) =>
      (f.api.request = async () => {
        throw Error("private provider error");
      }),
  ]) {
    const f = fixture();
    change(f);
    assert.equal(await inspectQuarantine(f.api, f.state, f.run), null);
  }
  for (const endpoint of [
    "/jobs?",
    "/check-suites/",
    "/check-runs?",
    "/artifacts?",
    "/pending_deployments",
    `/runs/${evidence.run.id}`,
  ]) {
    const f = fixture();
    const read = f.api.request.bind(f.api);
    f.api.request = (method, url) => {
      if (url.includes(endpoint)) throw Error("private provider error");
      return read(method, url);
    };
    assert.equal(await inspectQuarantine(f.api, f.state, f.run), null);
  }
});
test("missing/changed sentinel, any associated grant or lock invalidates the exception", async () => {
  const { inspectQuarantine } = require("../factory/quarantine.cjs");
  for (const change of [
    (s) => delete s.tickets[38],
    (s) => (s.tickets[38].origin = "factory"),
    (s) => (s.tickets[38].status = "blocked"),
    (s) => (s.tickets[38].drill.runId = "500"),
    (s) => (s.grants = {}),
    (s) => (Object.values(s.grants)[0].runId = String(evidence.run.id)),
    (s) => (s.active = { runId: String(evidence.run.id) }),
  ]) {
    const f = fixture();
    change(f.state);
    assert.equal(await inspectQuarantine(f.api, f.state, f.run), null);
  }
  // A valid unrelated factory grant still forbids containment if linked to this run.
  const f = fixture();
  const reserved = policy.reserve(
    f.state,
    { ...context, runId: "999" },
    policy.readConfig(vars)
  ).state;
  Object.values(reserved.grants).find((g) => g.ticket === 10).runId = String(evidence.run.id);
  reserved.active.runId = String(evidence.run.id);
  assert.equal(await inspectQuarantine(f.api, reserved, f.run), null);
});
test("current admission and preflight deny the known run ID at every attempt", () => {
  const config = policy.readConfig(vars);
  for (const runAttempt of [1, 2, 50]) {
    const request = { ...context, runId: String(evidence.run.id), runAttempt };
    assert.throws(
      () => policy.reserve(policy.emptyState(policy.REPOSITORY), request, config),
      /quarantin|retired|denied/i
    );
    const reserved = policy.reserve(policy.emptyState(policy.REPOSITORY), context, config);
    assert.throws(
      () => policy.preflight(reserved.state, reserved.grant.id, request, config),
      /quarantin|retired|denied/i
    );
  }
});
test("the actual hash-pinned legacy policy refuses the retained ledger offline before admission", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "factory-legacy-proof-"));
  try {
    const archive = path.resolve(__dirname, "../../docs/factory/evidence/stale-run-43467058965");
    assert.deepEqual(
      evidence.sourceSha256,
      require("../factory/quarantine-contract.cjs").SOURCE_SHA256
    );
    for (const name of [
      "policy.cjs",
      "recovery.cjs",
      "automation.cjs",
      "github.cjs",
      "factory-automatic.yml",
    ]) {
      const source = fs
        .readFileSync(path.join(archive, name + ".txt"), "utf8")
        .replace(/\r\n/g, "\n");
      const key = name.endsWith("yml") ? ".github/workflows/" + name : "scripts/factory/" + name;
      assert.equal(createHash("sha256").update(source).digest("hex"), evidence.sourceSha256[key]);
      fs.writeFileSync(path.join(directory, name), source);
    }
    const f = fixture();
    fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify(f.state));
    const reserved = policy.reserve(
      policy.emptyState(policy.REPOSITORY),
      context,
      policy.readConfig(vars)
    );
    const baseline = policy.finish(reserved.state, reserved.grant.id, { status: "blocked" });
    fs.writeFileSync(path.join(directory, "baseline.json"), JSON.stringify(baseline));
    fs.writeFileSync(
      path.join(directory, "probe.cjs"),
      `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      global.fetch = () => { throw Error('Network forbidden in proof'); };
      assert.ok(!Object.keys(process.env).some(k => /TOKEN|KEY|AUTH/i.test(k)));
      const legacy = require('./policy.cjs');
      legacy.validateState(JSON.parse(fs.readFileSync('baseline.json', 'utf8')));
      assert.throws(() => legacy.validateState(JSON.parse(fs.readFileSync('state.json', 'utf8'))), /ledger ticket counters/);
      console.log('legacy baseline accepted; retained drill ledger refused; no credentials');
    `
    );
    const env = Object.fromEntries(
      ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]])
    );
    const child = spawnSync(
      process.execPath,
      ["--permission", `--allow-fs-read=${directory}`, "probe.cjs"],
      { cwd: directory, env, encoding: "utf8", timeout: 5000 }
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /baseline accepted; retained drill ledger refused/);
    const workflow = fs.readFileSync(path.join(directory, "factory-automatic.yml"), "utf8");
    assert.match(workflow, /ref: \$\{\{ github.workflow_sha \}\}/);
    assert.match(workflow, /needs.pick.outputs.ready == 'true'/);
    assert.match(
      fs.readFileSync(path.join(directory, "github.cjs"), "utf8"),
      /validateState\(state\)/
    );
    assert.match(
      fs.readFileSync(path.join(directory, "automation.cjs"), "utf8"),
      /await this.ledger.read\(\)/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
