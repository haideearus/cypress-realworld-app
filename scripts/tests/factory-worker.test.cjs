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
test("both roles receive a validated fifty-turn ceiling without gaining tools", () => {
  const config = policy.readConfig({ ...vars, FACTORY_MAX_TURNS_PER_RUN: "50" });
  const code = worker.buildArgs(config, "code");
  const review = worker.buildArgs(config, "review");
  for (const args of [code, review]) {
    assert.match(args, /(?:^| )--max-turns 50(?: |$)/);
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
  fixture.prHeadOverride = "e".repeat(40);
  await assert.rejects(worker.prepare(api, config, ctx, options), /head/i);
});
