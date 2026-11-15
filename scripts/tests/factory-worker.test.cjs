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

test("dependency worker supplies fresh exact-commit facts without adding model tools or rewriting history", async (t) => {
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
  const base = writeVersion("1.0.0"),
    head = writeVersion("1.0.1");
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
  const api = {
    request: async (method, route, ...args) => {
      if (route.endsWith("/pulls/52")) return structuredClone(pr);
      if (route.endsWith("/pulls/52/files?per_page=3"))
        return [
          { filename: "package.json", status: "modified" },
          { filename: "yarn.lock", status: "modified" },
        ];
      if (route.endsWith("/git/ref/heads/main"))
        return { object: { sha: changedMain ? "f".repeat(40) : base } };
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
  const saved = await ledger.update((state) => {
    const next = lifecycle.claimDependency(state, pr, ctx, config);
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
    next.tickets["52"].ci = { head, passed: true, runId: 501 };
    return lifecycle.reserveDependencyReview(next, ctx, config);
  });
  const options = {
    grantId: saved.grant.id,
    cwd: app.cwd,
    environment: {},
    transport: async (url) =>
      new Response(
        JSON.stringify(
          url.endsWith("querybatch")
            ? { results: [{}, {}] }
            : {
                name: "foo",
                version: "1.0.1",
                dist: {
                  tarball: "https://registry.npmjs.org/foo/-/foo-1.0.1.tgz",
                  integrity,
                },
              }
        )
      ),
  };
  const before = (await ledger.read()).commit;
  const result = await worker.prepare(api, config, ctx, options);
  const input = JSON.parse(fs.readFileSync(path.join(app.cwd, ".factory-input/context.json")));
  assert.equal(
    input.dependencyFacts?.registry?.[0]?.version,
    "1.0.1",
    "reviewer is missing current registry facts"
  );
  assert.equal(input.dependencyFacts.base, base);
  assert.equal(input.dependencyFacts.head, head);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(app.cwd, ".factory-input/dependency-facts.json"))),
    input.dependencyFacts
  );
  assert.deepEqual(input.capabilities.fileTools, ["Read", "Glob", "Grep"]);
  assert.deepEqual(input.capabilities.shellCommands, []);
  assert.ok(result.claudeArgs.includes('--tools "Read,Glob,Grep"'));
  assert.equal((await ledger.read()).commit, before);
  changedMain = true;
  await assert.rejects(worker.prepare(api, config, ctx, options), /base|main/i);
  assert.equal((await ledger.read()).commit, before);
});
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
