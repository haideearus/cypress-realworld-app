const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { execFileSync } = require("node:child_process");
const yaml = require("js-yaml");
const repair = require("../factory/discovery-repair.cjs"),
  scan = require("../factory/secret-scan.cjs");
const worker = require("../factory/worker.cjs"),
  c = require("../factory/discovery-contract.cjs");
const fixture = require("./fixtures/finding96-blocked.cjs");
const failed = require("./fixtures/finding96-output-block.json");
const red = { outcome: "ready", redHash: c.digest("synthetic trusted RED") };
const green = { outcome: "observed-resolved", evidenceHash: c.digest("synthetic trusted GREEN") };
const bundle = () => ({
  kind: "code",
  grantId: failed.grant.id,
  base: failed.grant.head,
  files: [
    { path: "backend/synthetic.ts", mode: "100644", content: "export const fixed = true;\n" },
  ],
  evidence: "Synthetic RED before and GREEN after; not a live repair.",
});

test("public legacy receipt reproduces the final-output failure; v2 complete bundle scans clean", async () => {
  const raw = structuredClone(fixture.ticket.finding);
  const code = bundle();
  const legacy = {
    ...repair.repairProof(fixture.ticket, failed.grant, code, red, green),
    version: 1,
  };
  delete legacy.findingRef;
  legacy.key = fixture.ticket.finding.origin.key;
  await assert.rejects(
    scan.scanText(JSON.stringify({ ...code, findingVerification: legacy })),
    /blocked 1 finding.*generic-api-key/
  );
  code.findingVerification = repair.repairProof(fixture.ticket, failed.grant, code, red, green);
  assert.equal(code.findingVerification.version, 2);
  assert.equal(code.findingVerification.findingRef, fixture.ticket.finding.origin.key);
  assert.equal(code.findingVerification.key, undefined);
  assert.equal((await scan.scanText(JSON.stringify(code))).clean, true);
  assert.equal(repair.validRepairProof(fixture.ticket, failed.grant, code), true);
  assert.deepEqual(fixture.ticket.finding, raw);
});

test("actual collector to final GREEN receipt scans all generated content and binds the complete patch", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "factory-output-proof-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(cwd)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(cwd).startsWith("factory-output-proof-"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic fixture");
  git("config", "user.email", "fixture@example.invalid");
  fs.mkdirSync(path.join(cwd, "backend"));
  fs.writeFileSync(path.join(cwd, "backend/synthetic.ts"), "export const fixed = false;\n");
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture", "--no-gpg-sign");
  const head = git("rev-parse", "HEAD"),
    grant = { ...failed.grant, head };
  fs.writeFileSync(path.join(cwd, "backend/synthetic.ts"), "export const fixed = true;\n");
  fs.mkdirSync(path.join(cwd, ".factory-output"));
  fs.writeFileSync(path.join(cwd, ".factory-output/evidence.md"), "Synthetic RED/GREEN evidence.");
  const collected = worker.collectCode({ cwd, grantId: grant.id, head });
  const before = structuredClone(collected);
  const final = await repair.finalizeRepairBundle(fixture.ticket, grant, collected, red, green);
  assert.equal(final.findingVerification.version, 2);
  assert.equal(repair.validRepairProof(fixture.ticket, grant, final), true);
  assert.deepEqual(collected, before);
  assert.equal((await scan.scanText(JSON.stringify(final))).clean, true);
  const secret = ["sk", "ant", "oat01", "SyntheticOnlyValue12345678901234567890"].join("-");
  for (const inject of [
    (x) => (x.files[0].content += `\nexport const leaked = '${secret}';`),
    (x) => (x.evidence += secret),
    (x) => (x.extra = secret),
  ]) {
    const poisoned = structuredClone(collected);
    inject(poisoned);
    await assert.rejects(
      repair.finalizeRepairBundle(fixture.ticket, grant, poisoned, red, green),
      /Secret scanner|secret-like/i
    );
  }
});

test("new wire proof refuses identity changes, unknown/legacy fields and non-GREEN evidence", () => {
  const code = bundle();
  code.findingVerification = repair.repairProof(fixture.ticket, failed.grant, code, red, green);
  for (const change of [
    (x) => (x.findingVerification.version = 1),
    (x) => (x.findingVerification.key = fixture.ticket.finding.origin.key),
    (x) => (x.findingVerification.findingRef = "a".repeat(64)),
    (x) => (x.findingVerification.candidateHash = "a".repeat(64)),
    (x) => (x.findingVerification.grantId = "foreign"),
    (x) => (x.findingVerification.head = "a".repeat(40)),
    (x) => (x.findingVerification.filesHash = "a".repeat(64)),
    (x) => (x.findingVerification.redHash = "bad"),
    (x) => (x.findingVerification.greenHash = "bad"),
    (x) => (x.findingVerification.redOutcome = "observed-resolved"),
    (x) => (x.findingVerification.greenOutcome = "ready"),
    (x) => (x.files[0].content = "tampered"),
  ]) {
    const bad = structuredClone(code);
    change(bad);
    assert.equal(repair.validRepairProof(fixture.ticket, failed.grant, bad), false);
  }
  assert.throws(
    () =>
      repair.repairProof(fixture.ticket, failed.grant, code, red, { ...green, outcome: "ready" }),
    /incomplete/
  );
});

test("both Postgres service probes use the declared database identity", () => {
  for (const file of ["factory-ci.yml", "factory-model.yml"]) {
    const workflow = yaml.load(
      fs.readFileSync(path.join(__dirname, "../../.github/workflows", file), "utf8")
    );
    const service = Object.values(workflow.jobs).find((j) => j.services?.postgres).services
      .postgres;
    const command = /--health-cmd\s+"([^"]+)"/.exec(service.options)?.[1];
    assert.ok(command, `${file}: health command must contain explicit identity`);
    assert.deepEqual(command.split(/\s+/), [
      "pg_isready",
      "-U",
      service.env.POSTGRES_USER,
      "-d",
      service.env.POSTGRES_DB,
    ]);
    assert.equal(service.env.POSTGRES_USER, "factory_test");
    assert.equal(service.env.POSTGRES_DB, "rwa_test");
  }
});
