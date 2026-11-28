const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { GitHub, Ledger } = require("../factory/github.cjs");
const policy = require("../factory/policy.cjs");
const { criteriaHash, Controller } = require("../factory/controller.cjs");
const { vars, context, FactoryFixture } = require("./helpers/factory-fixtures.cjs");
let worker;
try {
  worker = require("../factory/worker.cjs");
} catch (e) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
}
function repo(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "factory-worker-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(cwd)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(cwd).startsWith("factory-worker-"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "Factory Fixture");
  git("config", "user.email", "factory-fixture@example.invalid");
  git("config", "core.autocrlf", "false");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src/a.ts"), "export const fixed = false;\n");
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "Synthetic baseline", "--no-gpg-sign");
  return { cwd, head: git("rev-parse", "HEAD") };
}
test("isolated worker adapter exists", () => assert.ok(worker, "missing model worker adapter"));

test("worker emits the named bot only for an active verified app wake reservation", async (t) => {
  const { receiverSetup } = require("./helpers/event-fixtures.cjs");
  const { verifyWake } = require("../factory/trusted-wake.cjs");
  const app = repo(t);
  const s = await receiverSetup();
  const proof = await verifyWake({ ...s, lane: "app", bind: true });
  const ctx = {
    ...s.context,
    ticket: s.issue.number,
    head: app.head,
    phase: "code",
    slot: "cycle1",
  };
  const config = policy.readConfig({
    ...vars,
    ...s.vars,
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
    FACTORY_GITHUB_APP_SLUG: "fixture-factory",
  });
  const { state, grant } = policy.reserve(
    policy.emptyState(ctx.repository),
    { ...ctx, wake: proof },
    config
  );
  const ticket = state.tickets[String(ctx.ticket)];
  ticket.criteriaHash = criteriaHash(s.issue);
  ticket.automatic = {
    workflowRef: ctx.workflowRef,
    workflowSha: ctx.workflowSha,
    runId: ctx.runId,
    runAttempt: ctx.runAttempt,
    appSlug: config.appSlug,
  };
  let snapshot = state;
  const encode = (data) => ({
    type: "file",
    encoding: "base64",
    content: Buffer.from(JSON.stringify(data)).toString("base64"),
  });
  const api = {
    async request(method, route) {
      assert.equal(method, "GET");
      if (/\/git\/ref\/heads\/factory\/(state|wakes)$/.test(route))
        return { object: { sha: "b".repeat(40) } };
      if (route.includes("/contents/state.json?")) return encode(snapshot);
      if (route.includes("/contents/wakes.json?")) return encode(s.store.state);
      return s.api.request(method, route);
    },
  };
  const options = { grantId: grant.id, cwd: app.cwd, environment: {} };
  assert.equal(
    (await worker.prepare(api, config, ctx, options)).allowedBots,
    "github-actions[bot]"
  );

  snapshot = policy.finish(state, grant.id, { status: "blocked" });
  await assert.rejects(worker.prepare(api, config, ctx, options), /stale model reservation/);
});

test("only the verified ordinary coding issue read can signal a pre-model hold for HTTP 500", async (t) => {
  const app = repo(t);
  const fixture = new FactoryFixture();
  const ctx = {
    ...context,
    head: app.head,
    workflowSha: app.head,
    workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
    event: "schedule",
  };
  const config = policy.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_PRIORITY_RETRY_ENABLED: "true",
    FACTORY_GITHUB_APP_SLUG: "fixture-factory",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
  });
  let failingPath;
  let status = 500;
  const api = new GitHub({
    token: "fixture-only",
    retryReads: true,
    fetch: async (url, options) =>
      failingPath && url.pathname.endsWith(failingPath)
        ? new Response(null, { status })
        : fixture.fetch(url, options),
  });
  const ledger = new Ledger(api);
  await ledger.initialize();
  const { grant, commit } = await ledger.update((original) => {
    const reserved = policy.reserve(original, ctx, config);
    const ticket = reserved.state.tickets[ctx.ticket];
    ticket.criteriaHash = criteriaHash(fixture.issues.get(ctx.ticket));
    ticket.automatic = {
      workflowRef: ctx.workflowRef,
      workflowSha: ctx.workflowSha,
      runId: ctx.runId,
      runAttempt: ctx.runAttempt,
      appSlug: config.appSlug,
    };
    return reserved;
  });
  const options = { grantId: grant.id, cwd: app.cwd, environment: {} };

  failingPath = `/issues/${ctx.ticket}`;
  assert.deepEqual(await worker.prepare(api, config, ctx, options), { temporaryGateway: true });
  assert.equal(fs.existsSync(path.join(app.cwd, ".factory-input/context.json")), false);
  await assert.rejects(
    worker.prepare(api, { ...config, priorityRetry: false }, ctx, options),
    /GitHub request failed \(500\)/
  );
  await assert.rejects(
    worker.prepare(api, config, { ...ctx, runAttempt: 2 }, options),
    /reservation/
  );

  status = 403;
  await assert.rejects(worker.prepare(api, config, ctx, options), /GitHub request failed \(403\)/);
  failingPath = "/git/ref/heads/factory/state";
  status = 500;
  await assert.rejects(worker.prepare(api, config, ctx, options), /GitHub request failed \(500\)/);
  failingPath = null;
  assert.equal((await ledger.read()).commit, commit);
});

async function assertDependencyReview(t, repaired = false) {
  const app = repo(t);
  const runGit = (...args) => execFileSync("git", args, { cwd: app.cwd, encoding: "utf8" }).trim();
  const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const writeVersion = (v) => {
    fs.writeFileSync(
      path.join(app.cwd, "package.json"),
      JSON.stringify({ dependencies: { foo: v } })
    );
    fs.writeFileSync(
      path.join(app.cwd, "yarn.lock"),
      `foo@${v}:\n  version "${v}"\n  resolved "https://registry.npmjs.org/foo/-/foo-${v}.tgz"\n  integrity ${integrity}\n`
    );
    runGit("add", "package.json", "yarn.lock");
    runGit("-c", "core.hooksPath=/dev/null", "commit", "-qm", v, "--no-gpg-sign");
    return runGit("rev-parse", "HEAD");
  };
  const base = writeVersion("1.0.0");
  const originalHead = writeVersion("1.0.1");
  if (repaired) {
    fs.writeFileSync(path.join(app.cwd, "src/a.ts"), "export const fixed = true;\n");
    runGit("add", "src/a.ts");
    runGit("-c", "core.hooksPath=/dev/null", "commit", "-qm", "Compatibility", "--no-gpg-sign");
  }
  const head = runGit("rev-parse", "HEAD");
  const d = require("../factory/dependency-contract.cjs");
  const a = require("../factory/dependency-analysis.cjs");
  const lifecycle = require("../factory/dependency-policy.cjs");
  const pr = {
    number: 52,
    state: "open",
    draft: false,
    user: { login: "dependabot[bot]", type: "Bot", id: 49699333 },
    head: {
      sha: head,
      ref: "dependabot/npm_and_yarn/foo-1.0.1",
      repo: { full_name: policy.REPOSITORY },
    },
    base: { sha: base, ref: "main", repo: { full_name: policy.REPOSITORY } },
  };
  const fixture = new FactoryFixture();
  const backing = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  let changedMain = false;
  let ciAttempt = 1;
  let forbidden = false;
  const api = {
    request: async (method, route, ...args) => {
      if (route.endsWith("/pulls/52")) return structuredClone(pr);
      if (/\/pulls\/52\/files/.test(route))
        return [
          { filename: "package.json", status: "modified" },
          { filename: "yarn.lock", status: "modified" },
          ...(repaired
            ? [
                {
                  filename: forbidden ? ".github/workflows/factory-ci.yml" : "src/a.ts",
                  status: "modified",
                },
              ]
            : []),
        ];
      if (route.endsWith("/git/ref/heads/main"))
        return { object: { sha: changedMain ? "f".repeat(40) : base } };
      if (route.endsWith(`/compare/${base}...${head}`))
        return { behind_by: 0, merge_base_commit: { sha: base } };
      if (route.endsWith("/actions/runs/501")) return (await transport(route)).json();
      return backing.request(method, route, ...args);
    },
  };
  const ledger = new Ledger(api);
  await ledger.initialize();
  const config = policy.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_GITHUB_APP_SLUG: "factory-example",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
  });
  const ctx = {
    ...context,
    ticket: 52,
    phase: "review",
    slot: "dependency",
    head,
    workflowRef: d.WORKFLOW,
    workflowSha: base,
  };
  let now = Date.now() - 61000;
  const clock = () => new Date(now);
  await ledger.update((state) => {
    const original = { ...pr, head: { ...pr.head, sha: originalHead } };
    let next = lifecycle.claimDependency(state, original, ctx, config, clock());
    if (repaired) {
      const reserved = lifecycle.reserveDependencyCompatibility(
        next,
        52,
        ctx,
        config,
        {
          package: { name: "foo", version: "1.0.1" },
          reason: "native_ci_failure",
        },
        clock()
      );
      const proof = { grantId: reserved.grant.id, originalHead, head, base };
      next = lifecycle.beginDependencyCompatibilityPublish(
        reserved.state,
        52,
        ctx,
        config,
        proof,
        clock()
      );
      next = lifecycle.recordDependencyCompatibility(next, 52, ctx, config, proof, clock());
    }
    next.tickets["52"].analysis = a.reportFor(
      {
        repository: policy.REPOSITORY,
        pr: 52,
        base,
        head,
        workflowSha: base,
        runId: ctx.runId,
        runAttempt: 1,
        stage: "analysis",
        toolDigest: a.toolDigest(),
      },
      { changed: 2, candidateVersions: 1, cleared: [], remainingBaseline: [] }
    );
    next.tickets["52"].ci = { head, passed: true, runId: 501, requestId: "worker-ci" };
    return { state: next };
  });
  let outage = true;
  const transport = async (url) => {
    if (outage && url.includes("registry.npmjs.org")) {
      outage = false;
      return new Response(null, { status: 503 });
    }
    let result;
    if (url.endsWith("/workflows/factory-ci.yml"))
      result = { id: 1, path: ".github/workflows/factory-ci.yml" };
    else if (url.endsWith("/runs/501"))
      result = {
        id: 501,
        workflow_id: 1,
        path: ".github/workflows/factory-ci.yml",
        head_sha: head,
        run_attempt: ciAttempt,
        event: "workflow_dispatch",
        display_title: "Factory CI / worker-ci",
        repository: { full_name: policy.REPOSITORY },
        head_repository: { full_name: policy.REPOSITORY },
        status: "completed",
        conclusion: "success",
      };
    else if (url.includes("/attempts/1/jobs"))
      result = {
        total_count: 1,
        jobs: [
          {
            id: 2,
            run_id: 501,
            head_sha: head,
            name: "verify",
            status: "completed",
            conclusion: "success",
            steps: [
              "Run yarn types && yarn lint && yarn test:unit:ci",
              "API and browser regression tests without cloud recording",
            ].map((name) => ({ name, status: "completed", conclusion: "success" })),
          },
        ],
      };
    else if (url.endsWith("querybatch")) result = { results: [{}, {}] };
    else
      result = {
        name: "foo",
        version: "1.0.1",
        dist: { tarball: "https://registry.npmjs.org/foo/-/foo-1.0.1.tgz", integrity },
      };
    return new Response(JSON.stringify(result));
  };
  const preflight = require("../factory/dependency-preflight.cjs");
  const candidate = new (require("../factory/dependencies.cjs").DependencyCoordinator)(
    api,
    config,
    ctx
  );
  const { packet, ready } = await preflight.prepare(
    candidate,
    52,
    (ticket) => ({
      base,
      head,
      baseManifest: runGit("show", base + ":package.json"),
      headManifest: runGit("show", head + ":package.json"),
      baseLock: runGit("show", base + ":yarn.lock"),
      headLock: runGit("show", head + ":yarn.lock"),
      ci: ticket.ci,
    }),
    {
      transport,
      clock,
      wait: async (ms) => {
        assert.equal(ms, 60000);
        const { state } = await ledger.read();
        assert.equal(state.tickets["52"].reviews, 0);
        assert.deepEqual(
          Object.values(state.grants).map((grant) => grant.phase),
          repaired ? ["code"] : []
        );
        now += ms;
      },
    }
  );
  assert.equal(ready, true);
  const prepared = (await ledger.read()).state;
  assert.deepEqual(
    prepared.tickets["52"].dependency.attempts.at(-1).evidence.map((attempt) => attempt.status),
    ["temporary", "ready"]
  );
  assert.equal(prepared.tickets["52"].reviews, 0);
  const saved = await ledger.update((state) =>
    lifecycle.reserveDependencyReview(state, ctx, config)
  );
  const packetPath = path.join(app.cwd, "..", path.basename(app.cwd) + "-facts.json");
  t.after(() => fs.rmSync(packetPath, { force: true }));
  fs.writeFileSync(packetPath, JSON.stringify({ ...packet, extra: "changed" }));
  const options = {
    grantId: saved.grant.id,
    cwd: app.cwd,
    environment: { FACTORY_DEPENDENCY_EVIDENCE: packetPath },
  };
  await assert.rejects(worker.prepare(api, config, ctx, options), /mismatched.*evidence/);
  fs.writeFileSync(packetPath, JSON.stringify(packet));
  const before = (await ledger.read()).commit;
  const result = await worker.prepare(api, config, ctx, options);
  const input = JSON.parse(fs.readFileSync(path.join(app.cwd, ".factory-input/context.json")));
  assert.equal(
    input.dependencyFacts?.registry?.[0]?.version,
    "1.0.1",
    "reviewer is missing current registry facts"
  );
  assert.equal(input.dependencyFacts.ciEvidence.status, "verified");
  assert.equal(input.dependencyFacts.ciEvidence.head, head);
  assert.equal(input.dependencyFacts.ciEvidence.runId, 501);
  assert.match(result.promptJson, /remembered release history/);
  assert.equal(input.dependencyFacts.base, base);
  assert.equal(input.dependencyFacts.head, head);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(app.cwd, ".factory-input/dependency-facts.json"))),
    input.dependencyFacts
  );
  assert.deepEqual(input.capabilities.fileTools, ["Read", "Glob", "Grep"]);
  assert.deepEqual(input.capabilities.shellCommands, []);
  assert.ok(result.claudeArgs.includes('--tools "Read,Glob,Grep"'));
  if (repaired) {
    assert.equal(input.dependencyCompatibility.originalHead, originalHead);
    assert.deepEqual(input.dependencyCompatibility.package, { name: "foo", version: "1.0.1" });
    assert.match(input.diff, /src\/a\.ts/);
    forbidden = true;
    await assert.rejects(worker.prepare(api, config, ctx, options), /forbidden files/);
    forbidden = false;
  }
  assert.equal((await ledger.read()).commit, before);
  ciAttempt = 2;
  await assert.rejects(worker.prepare(api, config, ctx, options), /exact-head CI/);
  ciAttempt = 1;
  changedMain = true;
  await assert.rejects(worker.prepare(api, config, ctx, options), /base|main/i);
  assert.equal((await ledger.read()).commit, before);
}
test(
  "dependency worker supplies fresh exact-commit facts without adding model tools or rewriting history",
  assertDependencyReview
);
test("dependency reviewer inspects receipt-bound compatibility app changes on the same PR", (t) =>
  assertDependencyReview(t, true));
test("prepared worker is fresh, restricted and bound to a committed reservation", async (t) => {
  const app = repo(t);
  const fixture = new FactoryFixture();
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  const ctx = { ...context, head: app.head };
  const config = policy.readConfig(vars);
  const saved = await ledger.update((state) => {
    const r = policy.reserve(state, ctx, config);
    r.state.tickets["10"].criteriaHash = criteriaHash(fixture.issues.get(10));
    return r;
  });
  const prepared = await worker.prepare(api, config, ctx, {
    grantId: saved.grant.id,
    cwd: app.cwd,
    environment: {},
  });
  assert.equal(prepared.allowedBots, "");
  assert.ok(prepared.claudeArgs.includes("--restricted"));
  assert.ok(prepared.claudeArgs.includes("--max-turns 20"));
  assert.ok(!/--resume|--continue/.test(prepared.claudeArgs));
  const input = JSON.parse(
    fs.readFileSync(path.join(app.cwd, ".factory-input/context.json"), "utf8")
  );
  assert.equal(input.head, app.head);
  assert.equal(input.ticket.number, 10);
  assert.equal(input.token, undefined);
  assert.deepEqual(input.capabilities.fileTools, ["Read", "Glob", "Grep", "Edit", "Write"]);
  assert.deepEqual(input.capabilities.shellCommands, [
    "yarn types",
    "yarn lint",
    "yarn test:unit:ci",
    "yarn build:production",
    "yarn test:production",
  ]);
  for (const command of input.capabilities.shellCommands)
    assert.ok(prepared.claudeArgs.includes("Bash(" + command + ")"));
  assert.equal(
    input.capabilities.regressionTargets.production,
    "scripts/tests/production-integration.test.cjs"
  );
  fs.writeFileSync(path.join(app.cwd, "src/a.ts"), "export const fixed = true;\n");
  fs.writeFileSync(
    path.join(app.cwd, ".factory-output/evidence.md"),
    "RED: regression failed before repair. GREEN: regression passed."
  );
  const bundle = worker.collectCode({ cwd: app.cwd, grantId: saved.grant.id, head: app.head });
  assert.equal(bundle.files.length, 1);
  assert.equal(bundle.files[0].path, "src/a.ts");
  assert.ok(bundle.files[0].content.includes("true"));
});
test("worker cannot prepare from a stale run attempt or a different local commit", async (t) => {
  const app = repo(t);
  const fixture = new FactoryFixture();
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  const ctx = { ...context, head: app.head };
  const config = policy.readConfig(vars);
  const saved = await ledger.update((state) => policy.reserve(state, ctx, config));
  await assert.rejects(
    worker.prepare(
      api,
      config,
      { ...ctx, runAttempt: 2 },
      { grantId: saved.grant.id, cwd: app.cwd, environment: {} }
    ),
    /reservation/
  );
});
test("both roles receive a validated hundred-turn ceiling without gaining tools", () => {
  const config = policy.readConfig({ ...vars, FACTORY_MAX_TURNS_PER_RUN: "100" });
  const code = worker.buildArgs(config, "code");
  const review = worker.buildArgs(config, "review");
  for (const args of [code, review]) {
    assert.match(args, /(?:^| )--max-turns 100(?: |$)/);
    assert.ok(args.includes("--permission-mode dontAsk"));
    assert.ok(args.includes("--safe-mode"));
    assert.ok(args.includes("--strict-mcp-config"));
  }
  assert.ok(code.includes('--tools "Read,Glob,Grep,Edit,Write,Bash"'));
  assert.ok(
    code.includes(
      '--allowedTools "Read,Glob,Grep,Edit,Write,Bash(yarn types),Bash(yarn lint),Bash(yarn test:unit:ci),Bash(yarn build:production),Bash(yarn test:production)"'
    )
  );
  assert.ok(review.includes('--tools "Read,Glob,Grep"'));
  assert.ok(review.includes('--allowedTools "Read,Glob,Grep"'));
  assert.ok(review.includes("TaskStop,Bash,PowerShell,Edit,Write,NotebookEdit,mcp__*"));
});

test("the real worker prepares a current-main recovery grant with unchanged command scope", async (t) => {
  const { exhaustedState, issue } = require("./helpers/factory-recovery-fixtures.cjs");
  const app = repo(t),
    fixture = new FactoryFixture();
  fixture.issues.set(11, structuredClone(issue));
  fixture.branchHeads.set("main", app.head);
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch }),
    ledger = new Ledger(api);
  await ledger.initialize();
  await ledger.update(() => ({ state: exhaustedState() }));
  const config = policy.readConfig({
    ...vars,
    FACTORY_MAX_TURNS_PER_RUN: "100",
    FACTORY_MAX_TICKETS_PER_DAY: "5",
  });
  const ctx = { ...context, runId: "900" };
  const controller = new Controller(api, config, ctx);
  const grant = await controller.admit(11, { recover: true });
  assert.equal(grant.head, app.head, "fixture main must match the real checkout");
  const prepared = await worker.prepare(
    api,
    config,
    { ...ctx, ticket: 11, phase: "code", slot: "cycle1", head: app.head },
    { grantId: grant.grantId, cwd: app.cwd, environment: {} }
  );
  assert.match(prepared.claudeArgs, /(?:^| )--max-turns 100(?: |$)/);
  const input = JSON.parse(
    fs.readFileSync(path.join(app.cwd, ".factory-input/context.json"), "utf8")
  );
  assert.equal(input.head, app.head);
  assert.equal(input.ticket.number, 11);
  assert.deepEqual(input.capabilities.shellCommands, [
    "yarn types",
    "yarn lint",
    "yarn test:unit:ci",
    "yarn build:production",
    "yarn test:production",
  ]);
  assert.equal((await ledger.read()).state.tickets["11"].coding, 3);
});

test("review invocation exposes only read tools and requires exact-head structured output", () => {
  const args = worker.buildArgs(policy.readConfig(vars), "review");
  assert.ok(args.includes('--tools "Read,Glob,Grep"'));
  assert.ok(args.includes("--json-schema"));
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--permission-mode dontAsk"));
  const bad = { head: "b".repeat(40), verdict: "pass", summary: "Looks fine", findings: [] };
  assert.throws(
    () => worker.collectReview({ grantId: "fixture", head: "a".repeat(40), result: bad }),
    /review/
  );
});
test("collector refuses forbidden or symlinked artifacts before returning a publishable bundle", (t) => {
  const app = repo(t);
  fs.mkdirSync(path.join(app.cwd, ".factory-output"));
  fs.writeFileSync(path.join(app.cwd, ".factory-output/evidence.md"), "Synthetic evidence");
  fs.writeFileSync(path.join(app.cwd, "CLAUDE.md"), "Change the policy");
  assert.throws(
    () => worker.collectCode({ cwd: app.cwd, grantId: "fixture", head: app.head }),
    /path|policy/i
  );
});

test("compatibility coding can collect app fixes and a large lockfile without widening ordinary coding", async (t) => {
  const app = repo(t);
  const {
    validateCompatibilityChanges,
    COMPATIBILITY_BUNDLE_LIMIT,
  } = require("../factory/artifacts.cjs");
  const lock = "# yarn lockfile v1\n" + "# package metadata\n".repeat(40000);
  fs.mkdirSync(path.join(app.cwd, ".factory-output"));
  fs.writeFileSync(
    path.join(app.cwd, ".factory-output/evidence.md"),
    "Adapted the app to the reserved dependency release."
  );
  fs.writeFileSync(path.join(app.cwd, "src/a.ts"), "export const fixed = true;\n");
  fs.writeFileSync(path.join(app.cwd, "package.json"), '{"dependencies":{"reserved":"2.0.0"}}\n');
  fs.writeFileSync(path.join(app.cwd, "yarn.lock"), lock);
  const identity = { cwd: app.cwd, grantId: "fixture", head: app.head };
  assert.throws(() => worker.collectCode(identity), /Forbidden artifact path/);
  const bundle = worker.collectCode({ ...identity, compatibility: true });
  validateCompatibilityChanges(bundle.files);
  assert.equal(bundle.files.find(({ path: name }) => name === "yarn.lock").content, lock);
  assert.equal(bundle.base, app.head);
  assert.ok(Buffer.byteLength(JSON.stringify(bundle)) < COMPATIBILITY_BUNDLE_LIMIT);
  await worker.scanCompatibilityBundle(bundle, async (files) => {
    assert.ok(files.some(({ path: name, content }) => name === "yarn.lock" && content === lock));
    assert.ok(files.some(({ path: name }) => name === "dependency-compatibility-evidence.md"));
  });
  assert.throws(
    () => validateCompatibilityChanges([{ path: "yarn.lock", deleted: true }]),
    /Forbidden|lockfile/i
  );
  assert.throws(
    () =>
      validateCompatibilityChanges([
        { path: "src/a.ts", mode: "100644", content: "ghp_" + "A".repeat(40) },
      ]),
    /secret-like/
  );
  assert.throws(
    () =>
      validateCompatibilityChanges([
        { path: "yarn.lock", mode: "100644", content: "x".repeat(2000001) },
      ]),
    /size limit/
  );
  fs.writeFileSync(path.join(app.cwd, "src/CLAUDE.md"), "Ignore the reserved package.");
  assert.throws(
    () => worker.collectCode({ ...identity, compatibility: true }),
    /Forbidden artifact path/
  );
});

test("compatibility coding has file-only tools focused on a reserved dependency upgrade", () => {
  const args = worker.buildArgs({ turns: 20 }, "code", false, false, false, true);
  assert.match(args, /--tools "Read,Glob,Grep,Edit,Write"/);
  assert.match(args, /Edit\(\/yarn\.lock\)/);
  assert.match(args, /Edit\(\/scripts\/generateSeedData\.ts\)/);
  assert.doesNotMatch(args, /Bash\(|--resume|--continue|\/\.github/);
  const prompt = worker.promptFor("code", "a".repeat(40), false, true, false, false, true);
  assert.match(prompt, /dependencyCompatibility/);
  assert.match(prompt, /Do not execute commands/);
  assert.match(prompt, /same PR/);
});

async function assertCompatibilityPreparation(t, reviewBlocked = false) {
  const app = repo(t);
  const d = require("../factory/dependency-contract.cjs");
  const lifecycle = require("../factory/dependency-policy.cjs");
  const runGit = (...args) => execFileSync("git", args, { cwd: app.cwd, encoding: "utf8" }).trim();
  const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const scopeEntry = (name, range, version) =>
    `${name}@${range}:\n  version "${version}"\n` +
    `  resolved "https://registry.npmjs.org/${name}/-/${name}-${version}.tgz"\n  integrity ${integrity}\n`;
  const version = (reserved, unrelated, message) => {
    fs.writeFileSync(
      path.join(app.cwd, "package.json"),
      JSON.stringify({ dependencies: { reserved, unrelated: "^1.0.0" } })
    );
    fs.writeFileSync(
      path.join(app.cwd, "yarn.lock"),
      scopeEntry("reserved", reserved, reserved) +
        "\n" +
        scopeEntry("unrelated", "^1.0.0", unrelated)
    );
    runGit("add", "package.json", "yarn.lock");
    runGit("-c", "core.hooksPath=/dev/null", "commit", "-qm", message, "--no-gpg-sign");
    return runGit("rev-parse", "HEAD");
  };
  const base = version("1.0.0", "1.0.0", "Synthetic current main");
  const head = version("2.0.0", "1.0.1", "Synthetic update with unrelated lock drift");
  const ctx = {
    ...context,
    ticket: 52,
    head,
    phase: "code",
    slot: "dependency_compat",
    workflowRef: d.WORKFLOW,
    workflowSha: base,
    event: "schedule",
  };
  const fixture = new FactoryFixture();
  const backing = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const config = policy.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_GITHUB_APP_SLUG: "factory-example",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
  });
  const pr = {
    number: 52,
    state: "open",
    draft: false,
    title: "Bump reserved to 2.0.0",
    body: "Synthetic release information",
    user: { login: "dependabot[bot]", type: "Bot", id: 49699333 },
    head: {
      sha: head,
      ref: "dependabot/npm_and_yarn/reserved-2.0.0",
      repo: { full_name: policy.REPOSITORY },
    },
    base: { sha: base, ref: "main", repo: { full_name: policy.REPOSITORY } },
  };
  let currentMain = base;
  let currentPR = pr;
  const api = {
    request: async (method, route, ...args) => {
      if (route.endsWith("/issues/52")) return { number: 52, title: pr.title, body: pr.body };
      if (route.endsWith("/pulls/52")) return structuredClone(currentPR);
      if (route.endsWith("/git/ref/heads/main")) return { object: { sha: currentMain } };
      return backing.request(method, route, ...args);
    },
  };
  const ledger = new Ledger(api);
  await ledger.initialize();
  const requested = {
    package: { name: "reserved", version: "2.0.0" },
    reason: reviewBlocked ? "review_blocked" : "native_ci_failure",
  };
  const feedback = {
    head,
    verdict: "changes_requested",
    summary:
      "The application still uses the legacy callback behavior that this exact dependency release removed.",
    findings: [
      {
        severity: "important",
        message:
          "The application callback needs to handle the result object returned by the new package.",
      },
    ],
  };
  const { grant } = await ledger.update((state) => {
    const firstRun = reviewBlocked ? { ...ctx, runId: "99" } : ctx;
    let next = lifecycle.claimDependency(state, pr, firstRun, config);
    if (reviewBlocked) {
      const ticket = next.tickets["52"];
      const attempt = ticket.dependency.attempts[0];
      const reviewGrant = "7366f29e-4936-4aae-b83f-c2fc379d95cf";
      ticket.status = "reviewing";
      ticket.reviews = 1;
      ticket.ci = {
        head,
        requestId: "17abfed5-4eae-4b95-af34-b07573754bb0",
        runId: 123,
        passed: true,
      };
      attempt.evidence = [
        { at: attempt.at, finishedAt: attempt.at, status: "ready", digest: "a".repeat(64) },
      ];
      next.grants[reviewGrant] = {
        id: reviewGrant,
        ticket: 52,
        phase: "review",
        slot: "dependency",
        head,
        runId: firstRun.runId,
        runAttempt: firstRun.runAttempt,
        status: "reserved",
        at: attempt.at,
      };
      next = policy.finish(next, reviewGrant, { status: "blocked" });
      next.tickets["52"].feedback = JSON.stringify(feedback);
      next = lifecycle.claimDependency(next, pr, ctx, config, new Date(), undefined, {
        compatibility: true,
      });
    }
    next.tickets["52"].feedback = "Unstructured notes belong outside this code context.";
    return lifecycle.reserveDependencyCompatibility(next, 52, ctx, config, requested);
  });
  const options = { grantId: grant.id, cwd: app.cwd, environment: {} };
  const before = (await ledger.read()).commit;
  currentPR = { ...pr, base: { ...pr.base, sha: "b".repeat(40) } };
  const prepared = await worker.prepare(api, config, ctx, options);
  assert.match(prepared.promptJson, /same PR/);
  assert.match(prepared.promptJson, /independentReview/);
  assert.equal(prepared.normalizedLock, true);
  const input = JSON.parse(fs.readFileSync(path.join(app.cwd, ".factory-input/context.json")));
  assert.deepEqual(input.dependencyCompatibility, {
    ...requested,
    base,
    originalHead: head,
    pr: 52,
    normalizedLockEntries: 1,
    ...(reviewBlocked && { independentReview: feedback }),
  });
  assert.equal(input.feedback, "", "unstructured ledger feedback must stay outside the model");
  assert.deepEqual(input.capabilities.shellCommands, []);
  assert.equal(input.ticket.body, pr.body);
  assert.equal((await ledger.read()).commit, before);
  assert.equal(runGit("rev-parse", "HEAD"), head);
  const readLock = (source) =>
    require("../factory/dependency-analysis.cjs")
      .toolsAt(path.join(__dirname, "../factory/dependency-tools"))
      .lockfile.parse(source).object;
  const lock = readLock(fs.readFileSync(path.join(app.cwd, "yarn.lock"), "utf8"));
  assert.equal(lock["reserved@2.0.0"].version, "2.0.0");
  assert.equal(lock["unrelated@^1.0.0"].version, "1.0.0");
  fs.writeFileSync(
    path.join(app.cwd, ".factory-output/evidence.md"),
    "Trusted phase restored the unrelated lock entry. No commands executed by model."
  );
  const bundle = worker.collectCode({ cwd: app.cwd, head, grantId: grant.id, compatibility: true });
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    ["yarn.lock"]
  );

  currentMain = "c".repeat(40);
  await assert.rejects(worker.prepare(api, config, ctx, options), /source changed/);
  currentMain = base;
  currentPR = { ...pr, head: { ...pr.head, sha: "d".repeat(40) } };
  await assert.rejects(worker.prepare(api, config, ctx, options), /source changed/);
}
test(
  "compatibility preparation binds native PR, reserved package and authoritative current main",
  assertCompatibilityPreparation
);
test("only a review-blocked compatibility reservation includes its archived independent findings", (t) =>
  assertCompatibilityPreparation(t, true));

test("collector identifies a forbidden test database before trying to read its oversized content", (t) => {
  const app = repo(t);
  fs.mkdirSync(path.join(app.cwd, "data"));
  fs.writeFileSync(path.join(app.cwd, "data/database.json"), "x".repeat(368209));
  execFileSync("git", ["add", "data/database.json"], { cwd: app.cwd });
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "Synthetic tracked runtime database",
      "--no-gpg-sign",
    ],
    { cwd: app.cwd }
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: app.cwd,
    encoding: "utf8",
  }).trim();
  fs.appendFileSync(path.join(app.cwd, "data/database.json"), "\n");
  fs.writeFileSync(path.join(app.cwd, "src/a.ts"), "export const fixed = true;\n");
  assert.throws(
    () => worker.collectCode({ cwd: app.cwd, grantId: "fixture", head }),
    (error) => {
      assert.match(error.message, /Forbidden artifact path.*data\/database.json/);
      assert.ok(!error.message.includes(app.cwd));
      return true;
    }
  );
});

test("collector identifies the relative file and byte limit for oversized code or evidence", (t) => {
  for (const [name, bytes, limit] of [
    ["src/a.ts", 200001, 200000],
    [".factory-output/evidence.md", 20001, 20000],
  ]) {
    const app = repo(t);
    fs.mkdirSync(path.join(app.cwd, ".factory-output"));
    fs.writeFileSync(path.join(app.cwd, "src/a.ts"), "export const fixed = true;\n");
    fs.writeFileSync(path.join(app.cwd, ".factory-output/evidence.md"), "RED then GREEN");
    fs.writeFileSync(path.join(app.cwd, name), "x".repeat(bytes));
    assert.throws(
      () => worker.collectCode({ cwd: app.cwd, grantId: "fixture", head: app.head }),
      (error) => {
        assert.ok(error.message.includes(name));
        assert.ok(error.message.includes(String(bytes)));
        assert.ok(error.message.includes(String(limit)));
        assert.ok(!error.message.includes(app.cwd));
        return true;
      }
    );
  }
});

test("collector diagnostics redact secret-like filenames", (t) => {
  const app = repo(t);
  const name = "src/ghp_" + "A".repeat(40) + ".ts";
  fs.writeFileSync(path.join(app.cwd, name), "x".repeat(200001));
  assert.throws(
    () => worker.collectCode({ cwd: app.cwd, grantId: "fixture", head: app.head }),
    (error) => {
      assert.match(error.message, /redacted/);
      assert.ok(!error.message.includes("ghp_"));
      return true;
    }
  );
});
test("existing owner PR worker requires successful CI before preparing its readonly review", async (t) => {
  const app = repo(t);
  const fixture = new FactoryFixture();
  fixture.branchHeads.set("agent/owner-harness", app.head);
  fixture.prs.push({
    number: 30,
    branch: "agent/owner-harness",
    baseSha: app.head,
    state: "open",
    user: { login: "haideearus" },
  });
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  const config = policy.readConfig(vars);
  const controller = new Controller(api, config, context, { sleep: async () => {}, maxPolls: 2 });
  const grant = await controller.admitPR(10, 30);
  const ctx = { ...context, phase: "review", slot: "existing", head: app.head };
  const options = { grantId: grant.grantId, cwd: app.cwd, environment: {} };
  await assert.rejects(worker.prepare(api, config, ctx, options), /CI proof/i);
  await controller.ci(10);
  const prepared = await worker.prepare(api, config, ctx, options);
  assert.ok(prepared.claudeArgs.includes('--tools "Read,Glob,Grep"'));
  const input = JSON.parse(
    fs.readFileSync(path.join(app.cwd, ".factory-input/context.json"), "utf8")
  );
  assert.equal(input.head, app.head);
  assert.match(input.ci, /\/actions\/runs\/501$/);
  assert.deepEqual(input.capabilities.fileTools, ["Read", "Glob", "Grep"]);
  assert.deepEqual(input.capabilities.shellCommands, []);
  fixture.prHeadOverride = "e".repeat(40);
  await assert.rejects(worker.prepare(api, config, ctx, options), /head/i);
});
