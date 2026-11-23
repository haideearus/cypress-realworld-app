const { test } = require("node:test");
const assert = require("node:assert/strict");
const d = require("../factory/dependency-contract.cjs");
const policy = require("../factory/policy.cjs");
const { claimDependency, finishPreparation } = require("../factory/dependency-policy.cjs");
const { prepare, evidenceTransport } = require("../factory/dependency-preflight.cjs");
const { vars, context, head: base } = require("./helpers/factory-fixtures.cjs");

function fixture() {
  const contextForRun = {
    ...context,
    event: "schedule",
    workflowRef: d.WORKFLOW,
    workflowSha: base,
  };
  const config = policy.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_GITHUB_APP_SLUG: "factory-example",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
  });
  const head = "b".repeat(40);
  const repo = { full_name: d.REPOSITORY };
  const pr = {
    number: 52,
    draft: false,
    state: "open",
    user: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
    head: { sha: head, ref: "dependabot/npm_and_yarn/foo-1.0.1", repo },
    base: { sha: base, ref: "main", repo },
  };
  let time = Date.now();
  const clock = () => new Date(time);
  let state = claimDependency(policy.emptyState(d.REPOSITORY), pr, contextForRun, config, clock());
  const t = state.tickets["52"];
  const analysis = require("../factory/dependency-analysis.cjs");
  const identity = require("../factory/dependencies.cjs").expectedReport(
    t,
    contextForRun,
    "analysis"
  );
  t.analysis = analysis.reportFor(identity, {
    changed: 2,
    candidateVersions: 1,
    cleared: [],
    remainingBaseline: [],
  });
  t.ci = { head, passed: true, runId: 9 };
  const lock = (version) =>
    `foo@${version}:\n  version "${version}"\n  resolved "https://registry.npmjs.org/foo/-/foo-${version}.tgz"\n  integrity sha512-${Buffer.alloc(64, 1).toString("base64")}\n`;
  const source = () => ({
    base,
    head,
    ci: t.ci,
    baseManifest: '{"dependencies":{"foo":"1.0.0"}}',
    headManifest: '{"dependencies":{"foo":"1.0.1"}}',
    baseLock: lock("1.0.0"),
    headLock: lock("1.0.1"),
  });
  let stopped = false;
  const coordinator = {
    config,
    context: contextForRun,
    ticket: async () => {
      if (stopped) throw Error("Emergency stop active");
      return state.tickets["52"];
    },
    pr: async () => pr,
    controller: { activeRun: () => {} },
    ledger: {
      update: async (fn) => {
        state = fn(structuredClone(state)).state;
      },
    },
  };
  return {
    coordinator,
    clock,
    source,
    wait: async (ms) => {
      time += ms;
    },
    stop: () => {
      stopped = true;
    },
    state: () => state,
    finish: () => finishPreparation(state, 52, contextForRun),
  };
}

test("recovery records both failed outage checks, then releases the preparation without a reservation", async () => {
  const f = fixture();
  let calls = 0;
  const result = await prepare(f.coordinator, 52, f.source, {
    clock: f.clock,
    wait: f.wait,
    transport: async () => {
      calls++;
      return new Response(null, { status: 503 });
    },
  });
  assert.equal(result.ready, false);
  assert.equal(calls, 2);
  const finished = f.finish();
  const ticket = finished.tickets["52"];
  assert.deepEqual(
    ticket.dependency.attempts[0].evidence.map((row) => row.status),
    ["temporary", "held"]
  );
  assert.equal(ticket.reviews, 0);
  assert.equal(Object.keys(finished.grants).length, 0);
  assert.equal(finished.active, null);
  assert.match(ticket.feedback, /502, 503 or 504/);
  assert.deepEqual(finished.days, f.state().days);
});

test("invalid evidence and a confirmed rate limit each stop without a retry", async () => {
  for (const [status, reason] of [
    [200, "invalid_public_evidence"],
    [429, "public_rate_limit"],
  ]) {
    const f = fixture();
    const result = await prepare(f.coordinator, 52, f.source, {
      clock: f.clock,
      wait: () => assert.fail("unexpected retry"),
      transport: async () => new Response("{}", { status }),
    });
    assert.equal(result.ready, false);
    const evidence = f.state().tickets["52"].dependency.attempts[0].evidence;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].reason, reason);
  }
});

test("a stop during the delay preserves the first check without starting the second", async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(
    prepare(f.coordinator, 52, f.source, {
      clock: f.clock,
      wait: async () => f.stop(),
      transport: async () => {
        calls++;
        return new Response(null, { status: 502 });
      },
    }),
    /stop active/i
  );
  assert.equal(calls, 1);
  assert.equal(f.state().tickets["52"].dependency.attempts[0].evidence[0].status, "temporary");
});

test("only the fixed same-repository CI reads receive the GitHub job token", async () => {
  const seen = [];
  const wrapped = evidenceTransport("fixture-only", async (url, options) => seen.push(options));
  await wrapped(`https://api.github.com/repos/${d.REPOSITORY}/actions/runs/1`, {
    method: "GET",
    redirect: "error",
  });
  await wrapped("https://api.github.com/repos/lodash/lodash/releases/tags/1", { method: "GET" });
  await wrapped("https://registry.npmjs.org/lodash/1", { method: "GET" });
  assert.equal(seen[0].headers.Authorization, "Bearer fixture-only");
  assert.equal(seen[0].redirect, "error");
  assert.equal(seen[1].headers, undefined);
  assert.equal(seen[2].headers, undefined);
});
