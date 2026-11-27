const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");
const { Controller } = require("../factory/controller.cjs");
const { GitHub, Ledger } = require("../factory/github.cjs");
const { readConfig, REPOSITORY, AUTOMATIC_WORKFLOW_REF } = require("../factory/policy.cjs");
const dependency = require("../factory/dependency-contract.cjs");
const { FactoryFixture, vars, context } = require("./helpers/factory-fixtures.cjs");
const root = path.resolve(__dirname, "../..");
const workflow = path.join(root, ".github/workflows/factory-review-status.yml");

function loadWorkflow() {
  assert.ok(
    fs.existsSync(workflow),
    "a real pull-request gate job must publish the required status"
  );
  return yaml.load(fs.readFileSync(workflow, "utf8"));
}
function inlineStep(id) {
  const flow = loadWorkflow();
  const source = flow.jobs.gate.steps.find((s) => s.id === id)?.run;
  assert.ok(source, `the workflow needs its ${id} step`);
  const match = source.match(/^node <<'NODE'\n([\s\S]+)\nNODE\s*$/);
  assert.ok(match, "the verifier must be the actual inline workflow entry");
  const filename = path.join(root, ".factory-inline-gate.cjs");
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(root);
  compiled._compile(match[1], filename);
  return compiled.exports;
}
const verifier = () => inlineStep("verify").verify;
class GateFixture extends FactoryFixture {
  constructor() {
    super();
    this.actionsCalls = [];
    const baseFetch = this.fetch;
    this.fetch = async (url, options = {}) => {
      const u = new URL(url);
      const route = u.pathname.replace(`/repos/${REPOSITORY}`, "");
      const method = options.method || "GET";
      const respond = (status, data) =>
        new Response(data === null ? null : JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (route.startsWith("/actions/")) this.actionsCalls.push({ method, route });
      const response = await baseFetch(url, options);
      if (method === "GET" && /^\/pulls\/\d+$/.test(route)) {
        const pr = await response.json();
        pr.base.repo = { full_name: REPOSITORY };
        return respond(200, this.patchPR ? this.patchPR(pr) : pr);
      }
      return response;
    };
  }
}
async function setup(approved = true) {
  const fixture = new GateFixture();
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  fixture.branchHeads.set("agent/owner-gate", "d".repeat(40));
  fixture.prs.push({
    number: 30,
    branch: "agent/owner-gate",
    state: "open",
    user: { login: "haideearus" },
  });
  const controller = new Controller(api, readConfig(vars), context, {
    sleep: async () => {},
    maxPolls: 2,
  });
  if (approved) {
    const grant = await controller.admitPR(10, 30);
    const ci = await controller.ci(10);
    await controller.assessPR(10, { ci: "success", review: "success" }, ci.runId, grant.grantId, {
      kind: "review",
      grantId: grant.grantId,
      base: grant.head,
      result: {
        head: grant.head,
        verdict: "pass",
        summary:
          "Reviewed src/example.ts against the ticket criteria; regression coverage and unchanged permission boundaries support this head, with no blocking findings.",
        findings: [],
      },
    });
  }
  const env = {
    GITHUB_REPOSITORY: REPOSITORY,
    FACTORY_PR: "30",
    FACTORY_HEAD: "d".repeat(40),
    FACTORY_ENABLED: "false",
    FACTORY_VERIFIER_SHA: fixture.branchHeads.get("main"),
  };
  return { fixture, api, ledger, controller, env };
}
function corrupt(fixture, mutate) {
  const commit = fixture.objects.get(fixture.head);
  const tree = fixture.objects.get(commit.tree);
  const blob = fixture.objects.get(tree.tree.find((f) => f.path === "state.json").sha);
  const state = JSON.parse(Buffer.from(blob.content, "base64"));
  mutate(state);
  blob.content = Buffer.from(JSON.stringify(state)).toString("base64");
}

test("required review status is a native pull-request job with trusted base code and no model credential", () => {
  const flow = loadWorkflow();
  assert.deepEqual(Object.keys(flow.on), ["pull_request"]);
  assert.deepEqual(flow.on.pull_request.branches, ["main"]);
  assert.ok(flow.on.pull_request.types.includes("labeled"));
  const job = flow.jobs.gate;
  assert.equal(job.name, "Factory review gate");
  assert.deepEqual(job.permissions, { contents: "read", "pull-requests": "read" });
  assert.equal(job["timeout-minutes"], 5);
  assert.equal(job.if, undefined, "the required job must not silently skip missing review proof");
  assert.notEqual(job["continue-on-error"], true);
  const verify = job.steps.find((s) => s.id === "verify");
  assert.notEqual(verify["continue-on-error"], true);
  assert.equal(verify.name, "Verify exact-head review with current trusted main");
  assert.equal(verify.env.FACTORY_VERIFIER_SHA, "${{ steps.main.outputs.sha }}");
  const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.repository, "${{ github.repository }}");
  assert.equal(checkout.with.ref, "${{ steps.main.outputs.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.doesNotMatch(JSON.stringify(flow), /secrets\.|CLAUDE|ANTHROPIC|OPENAI|workflow_dispatch/);
  for (const step of job.steps) if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
});

test("a fresh native gate resolves the same repository's protected main instead of the frozen PR event base", async () => {
  const { fixture } = await setup(false);
  const current = "68b111eb98a0d6778db3fdc071a5b82a94047fdc";
  fixture.branchHeads.set("main", current);
  const env = {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_EVENT_NAME: "pull_request",
    FACTORY_BASE_REPOSITORY: REPOSITORY,
    FACTORY_BASE_REF: "main",
    FACTORY_BASE_SHA: "4a3c5b7236d0885c8259778c9a66da68da78cc61",
    GH_TOKEN: "fixture-only",
  };
  const { resolveMain } = inlineStep("main");
  const calls = [];
  const transport = (url, options) => {
    calls.push([options.method, url]);
    return fixture.fetch(url, options);
  };
  assert.equal(await resolveMain(env, transport), current);
  assert.deepEqual(calls, [["GET", `https://api.github.com/repos/${REPOSITORY}/branches/main`]]);
  await assert.rejects(
    resolveMain({ ...env, FACTORY_BASE_REPOSITORY: "other/repo" }, fixture.fetch)
  );
  await assert.rejects(
    resolveMain({ ...env, GITHUB_EVENT_NAME: "workflow_dispatch" }, fixture.fetch)
  );
  for (const response of [
    { name: "main", protected: false, commit: { sha: current } },
    { name: "pr-head", protected: true, commit: { sha: current } },
    { name: "main", protected: true, commit: { sha: "refs/pull/299/head" } },
  ]) {
    await assert.rejects(
      resolveMain(env, async () => Response.json(response)),
      /protected main/i
    );
  }
});

test("the initially resolved verifier cannot pass after protected main moves", async () => {
  const { env, api, fixture } = await setup();
  fixture.branchHeads.set("main", "b".repeat(40));
  await assert.rejects(verifier()(env, api), /trusted main changed/i);
});

test("#299's fresh gate verifies its saved answer while the ledger retains #273's newer recovery", async () => {
  const { fixture, api, env, ledger } = await setup(false);
  const oldBase = "4a3c5b7236d0885c8259778c9a66da68da78cc61";
  const current = "68b111eb98a0d6778db3fdc071a5b82a94047fdc";
  const head = "9a348af64d89bb3c0fbd0f527b86ecd733dbcb4c";
  const branch = `agent/dependency-alert-${"c".repeat(64)}`;
  const at = "2026-11-27T21:06:19.292Z";
  const coding = "00000000-0000-4000-8000-000000000001";
  const approval = "00000000-0000-4000-8000-000000000002";
  const firstHead = "1".repeat(40);
  const secondHead = "2".repeat(40);
  const thirdHead = "3".repeat(40);
  const finalHead = "4".repeat(40);
  const reviewRun = "46066424823";
  fixture.branchHeads.set("main", current);
  fixture.branchHeads.set(branch, head);
  fixture.prs.push({ number: 299, branch, state: "open", baseSha: oldBase });
  const parent = (runId, parentHead) => ({
    runId,
    runAttempt: 1,
    workflowSha: current,
    head: parentHead,
  });
  const ci = (runId, ciHead) => ({ runId, requestId: coding, head: ciHead, passed: true });
  await ledger.update((state) => {
    state.days["2026-11-27"] = [273, 299];
    state.grants[coding] = {
      id: coding,
      ticket: 273,
      phase: "code",
      slot: "cycle1",
      ...parent("10", firstHead),
      status: "finished",
      outcome: "awaiting_review",
      at,
    };
    state.tickets[273] = {
      origin: "factory",
      coding: 1,
      reviews: 0,
      retries: 0,
      status: "blocked",
      head: finalHead,
      pr: 274,
      branch: "agent/factory-273",
      automatic: {
        runId: "10",
        runAttempt: 1,
        workflowRef: AUTOMATIC_WORKFLOW_REF,
        workflowSha: current,
        appSlug: "fixture-factory-app",
      },
      approval: null,
      publishedRecovery: {
        sourceCi: ci(741, firstHead),
        refreshes: [
          { from: firstHead, base: secondHead },
          { from: secondHead, base: thirdHead },
          { from: thirdHead, base: finalHead },
        ],
        previousParent: parent("20", secondHead),
        parent: parent("40", finalHead),
        finalContinuation: { failedParent: parent("30", thirdHead), priorCi: ci(742, thirdHead) },
      },
    };
    state.grants[approval] = {
      id: approval,
      ticket: 299,
      phase: "review",
      slot: "dependency",
      ...parent(reviewRun, head),
      status: "finished",
      outcome: "reviewed",
      at,
    };
    state.tickets[299] = {
      origin: "dependency-pr",
      coding: 0,
      reviews: 1,
      retries: 0,
      status: "reviewed",
      pr: 299,
      branch,
      head,
      criteriaHash: dependency.criteria(299),
      ci: ci(46066640526, head),
      feedback: JSON.stringify({
        head,
        verdict: "pass",
        summary:
          "Reviewed the ws lockfile update, available compatibility evidence and unchanged dependency constraints for the proposed revision.",
        findings: [],
      }),
      approval: {
        pr: 299,
        head,
        grant: approval,
        verdict: "pass",
        source: "claude-subscription",
        fixture: false,
        evidence: `https://github.com/${REPOSITORY}/actions/runs/${reviewRun}`,
      },
      dependency: {
        version: 1,
        pr: 299,
        workflowRef: dependency.WORKFLOW,
        workflowSha: current,
        runId: reviewRun,
        runAttempt: 1,
        appSlug: "fixture-factory-app",
        attempts: [{ ...parent(reviewRun, head), base: current, at }],
      },
    };
    return { state };
  });
  const before = await ledger.read();
  const hydrated = {
    ...env,
    FACTORY_BASE_REPOSITORY: REPOSITORY,
    FACTORY_BASE_REF: "main",
    FACTORY_BASE_SHA: oldBase,
    FACTORY_HEAD: head,
    FACTORY_PR: "299",
    GITHUB_EVENT_NAME: "pull_request",
    GH_TOKEN: "fixture-only",
  };
  const { resolveMain } = inlineStep("main");
  const verifierSha = await resolveMain(hydrated, fixture.fetch);
  assert.equal(verifierSha, current);
  const result = await verifier()({ ...hydrated, FACTORY_VERIFIER_SHA: verifierSha }, api);
  assert.equal(result.evidence, before.state.tickets[299].approval.evidence);
  assert.deepEqual(await ledger.read(), before);
  assert.deepEqual(fixture.runs, []);
});
test("the actual native verifier passes genuine exact-head fixture proof while the factory is disabled without writes", async () => {
  const { api, ledger, fixture, env } = await setup();
  const before = fixture.head;
  const calls = fixture.calls.length;
  assert.equal((await verifier()(env, api)).ok, true);
  assert.equal(fixture.head, before);
  assert.ok(fixture.calls.slice(calls).every((c) => c.method === "GET"));
  assert.equal((await ledger.read()).state.tickets["10"].reviews, 1);
});
test("native verifier fails for missing approval and an unavailable ledger", async () => {
  const s = await setup(false);
  await assert.rejects(verifier()(s.env, s.api), /review/i);
  s.fixture.head = null;
  await assert.rejects(verifier()(s.env, s.api), /GitHub|ledger/i);
});
test("the exact stdin command really invokes the verifier and exits unsuccessfully without approval", async () => {
  for (const approved of [false, true]) {
    const s = await setup(approved);
    const source = loadWorkflow().jobs.gate.steps.find((step) => step.id === "verify").run;
    const inline = source.match(/^node <<'NODE'\n([\s\S]+)\nNODE\s*$/)[1];
    const snapshot = {
      head: s.fixture.head,
      objects: [...s.fixture.objects],
      branchHeads: [...s.fixture.branchHeads],
      prs: s.fixture.prs,
    };
    const preload = `const fixture = new (require('./scripts/tests/helpers/factory-fixtures.cjs').FactoryFixture)();
      const snapshot = ${JSON.stringify(snapshot)};
      fixture.head = snapshot.head; fixture.objects = new Map(snapshot.objects);
      fixture.branchHeads = new Map(snapshot.branchHeads); fixture.prs = snapshot.prs;
      const original = fixture.fetch;
      global.fetch = async (url, options) => {
        const response = await original(url, options);
        if (!new URL(url).pathname.endsWith('/pulls/30')) return response;
        const pr = await response.json();
        pr.base.repo = { full_name: process.env.GITHUB_REPOSITORY };
        return Response.json(pr);
      };\n`;
    const result = spawnSync(process.execPath, ["-"], {
      cwd: root,
      input: preload + inline,
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, ...s.env, GH_TOKEN: "fixture-only" },
    });
    assert.equal(result.status, approved ? 0 : 1, result.stderr);
    assert.match(approved ? result.stdout : result.stderr, /[Ii]ndependent.*review/);
  }
});
test("native verifier refuses stale, fake and failed approval or corrupt serialized state", async () => {
  for (const mutation of [
    (t) => {
      t.approval = null;
    },
    (t) => {
      t.approval.fixture = true;
    },
    (t) => {
      t.approval.source = "invented";
    },
    (t) => {
      t.approval.head = "e".repeat(40);
    },
    (t) => {
      t.approval.verdict = "changes_requested";
    },
    (t) => {
      t.reviews = 0;
    },
  ]) {
    const s = await setup();
    corrupt(s.fixture, (state) => mutation(state.tickets["10"]));
    await assert.rejects(verifier()(s.env, s.api), /review|state|ledger|count/i);
  }
});
test("native verifier refuses changed heads, closed PRs and events outside this fork", async () => {
  const s = await setup();
  const verify = verifier();
  await assert.rejects(verify({ ...s.env, FACTORY_HEAD: "e".repeat(40) }, s.api), /PR|head/i);
  await assert.rejects(verify({ ...s.env, FACTORY_PR: "invalid" }, s.api), /PR/i);
  await assert.rejects(verify({ ...s.env, GITHUB_REPOSITORY: "other/repo" }, s.api), /repository/i);
  s.fixture.patchPR = (pr) => ({ ...pr, head: { ...pr.head, repo: { full_name: "other/repo" } } });
  await assert.rejects(verify(s.env, s.api), /repository/i);
  s.fixture.patchPR = (pr) => ({ ...pr, base: { ref: "other" } });
  await assert.rejects(verify(s.env, s.api), /PR/i);
  s.fixture.patchPR = null;
  s.fixture.prs[0].state = "closed";
  await assert.rejects(verify(s.env, s.api), /PR/i);
});
test("controller reports review evidence without Actions calls or usage changes", async () => {
  const s = await setup();
  const before = s.fixture.head;
  const actionsBefore = s.fixture.actionsCalls.length;
  const result = await s.controller.gate(30);
  assert.equal(result.ok, true);
  assert.equal(s.fixture.checks.at(-1).name, "Factory review evidence");
  assert.equal(s.fixture.head, before);
  assert.equal(s.fixture.actionsCalls.length, actionsBefore);
  assert.equal(s.fixture.runs.length, 1);
});
test("metadata jobs retain their original permissions without new Actions write grants", () => {
  for (const file of ["factory-pr-review.yml", "factory-cycle.yml"]) {
    const flow = yaml.load(fs.readFileSync(path.join(root, ".github/workflows", file), "utf8"));
    assert.equal(flow.jobs.assess.permissions.actions, "read");
    assert.equal(flow.jobs.review.permissions.contents, "read");
  }
  const wrapper = yaml.load(
    fs.readFileSync(path.join(root, ".github/workflows/factory-review-gate.yml"), "utf8")
  );
  assert.equal(wrapper.jobs.gate.permissions.actions, undefined);
});
