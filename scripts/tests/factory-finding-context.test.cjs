const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { execFileSync } = require("node:child_process");
const { GitHub, Ledger } = require("../factory/github.cjs");
const p = require("../factory/policy.cjs");
const c = require("../factory/discovery-contract.cjs");
const worker = require("../factory/worker.cjs");
const scan = require("../factory/secret-scan.cjs");
const fixture = require("./fixtures/finding96-blocked.cjs");
const { vars, context, FactoryFixture } = require("./helpers/factory-fixtures.cjs");

test("legacy public finding metadata reproduces both scanner matches; projection scans without altering raw proof", async () => {
  const ticket = structuredClone(fixture.ticket),
    record = structuredClone(fixture.record);
  const before = structuredClone({ ticket, record });
  await assert.rejects(
    scan.scanText(
      JSON.stringify(
        { origin: ticket.finding.origin, currentIntake: ticket.finding.intake },
        null,
        2
      )
    ),
    /blocked 2 finding.*generic-api-key/
  );
  const projected = worker.findingEvidenceForModel(ticket, record);
  assert.equal(projected.origin.issue, 96);
  assert.equal(projected.origin.candidateHash, ticket.finding.origin.candidateHash);
  assert.equal(projected.origin.key, undefined);
  assert.equal(projected.currentIntake.key, undefined);
  assert.deepEqual(Object.keys(projected.origin).sort(), [
    "candidateHash",
    "criteriaHash",
    "issue",
  ]);
  assert.deepEqual(Object.keys(projected.currentIntake).sort(), [
    "evidenceHash",
    "head",
    "outcome",
  ]);
  assert.equal((await scan.scanText(JSON.stringify(projected, null, 2))).clean, true);
  assert.deepEqual({ ticket, record }, before);
});

test("actual prepared finding context passes unchanged scanner; secrets in reproducer or feedback still fail", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "factory-finding-context-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(cwd)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(cwd).startsWith("factory-finding-context-"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic fixture");
  git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(cwd, "README.md"), "Synthetic fixture\n");
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture", "--no-gpg-sign");
  const head = git("rev-parse", "HEAD"),
    ctx = {
      ...context,
      ticket: 96,
      runId: "800",
      workflowSha: head,
      head,
      workflowRef: p.AUTOMATIC_WORKFLOW_REF,
    };
  const config = p.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_GITHUB_APP_SLUG: "fixture-factory",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
  });
  const backend = new FactoryFixture(),
    backing = new GitHub({ token: "fixture-only", fetch: backend.fetch });
  const issue = {
    number: 96,
    ...require("../factory/discovery-finding-contract.cjs").issueText(fixture.record),
  };
  const api = {
    request: async (m, url, ...args) =>
      url.endsWith("/issues/96") ? structuredClone(issue) : backing.request(m, url, ...args),
  };
  const ledger = new Ledger(api);
  await ledger.initialize();
  const record = structuredClone(fixture.record),
    finding = { ...record.candidate.oracle },
    originalTest = "// synthetic reproducer";
  record.candidate.findingHash = c.digest(finding);
  record.candidate.testHash = c.digest(originalTest);
  let rawFinding;
  const saved = await ledger.update((state) => {
    const r = p.reserve(state, ctx, config),
      ticket = r.state.tickets["96"];
    ticket.criteriaHash = require("../factory/controller.cjs").criteriaHash(issue);
    ticket.automatic = {
      workflowRef: ctx.workflowRef,
      workflowSha: head,
      runId: ctx.runId,
      runAttempt: 1,
      appSlug: config.appSlug,
    };
    ticket.finding = structuredClone(fixture.ticket.finding);
    ticket.finding.origin.criteriaHash = ticket.criteriaHash;
    ticket.finding.intake.head = head;
    ticket.finding.intake.id = c.digest([
      ticket.finding.intake.key,
      ticket.finding.intake.context.runId,
      head,
    ]);
    rawFinding = structuredClone(ticket.finding);
    return r;
  });
  let verified = 0;
  t.mock.method(
    require("../factory/discovery-origin.cjs"),
    "verifyRepairOrigin",
    async (_api, _issue, proof) => {
      verified++;
      assert.deepEqual(proof, rawFinding);
      assert.equal(fs.existsSync(path.join(cwd, ".factory-input/context.json")), false);
      return true;
    }
  );
  t.mock.method(
    require("../factory/discovery-finding-store.cjs").FindingStore.prototype,
    "read",
    async () => ({ state: { records: { [rawFinding.origin.key]: structuredClone(record) } } })
  );
  const root = path.join(cwd, `finding-repair-${saved.grant.id}`);
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(root, "red.json"),
    JSON.stringify({
      grantId: saved.grant.id,
      head,
      outcome: "ready",
      candidateHash: rawFinding.origin.candidateHash,
    })
  );
  const source = path.join(cwd, "evidence");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "evidence.json"),
    JSON.stringify({ findings: [{ finding, original: { test: originalTest } }] })
  );
  await worker.prepare(api, config, ctx, {
    grantId: saved.grant.id,
    cwd,
    environment: { RUNNER_TEMP: cwd, FACTORY_FINDING_INPUT: source },
  });
  const input = JSON.parse(fs.readFileSync(path.join(cwd, ".factory-input/context.json"), "utf8"));
  assert.equal(verified, 1);
  assert.equal(input.findingEvidence.originalTest, originalTest);
  assert.equal(input.findingEvidence.trustedRed.grantId, saved.grant.id);
  assert.equal((await scan.scanText(JSON.stringify(input, null, 2))).clean, true);
  assert.deepEqual((await ledger.read()).state.tickets["96"].finding, rawFinding);
  const credential = ["sk", "ant", "oat01", "a".repeat(24)].join("-");
  for (const target of ["reproducer", "feedback"]) {
    const changed = structuredClone(input);
    if (target === "reproducer") changed.findingEvidence.originalTest += credential;
    else changed.feedback = credential;
    await assert.rejects(scan.scanText(JSON.stringify(changed, null, 2)), /factory-claude-oauth/);
  }
});
