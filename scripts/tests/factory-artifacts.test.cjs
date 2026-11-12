const test = require("node:test");
const assert = require("node:assert/strict");
let artifact;
try {
  artifact = require("../factory/artifacts.cjs");
} catch (e) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
}
const head = "a".repeat(40);
test("artifact validators exist", () => assert.ok(artifact, "missing artifact validation"));
test("ordinary source edits and deletions are accepted without executing content", () => {
  assert.doesNotThrow(() =>
    artifact.validateChanges([
      {
        path: "src/components/Thing.tsx",
        mode: "100644",
        content: 'throw new Error("never execute publisher code");',
      },
      { path: "backend/old.ts", deleted: true },
    ])
  );
});
test("policy, secret, dependency, traversal, absolute and symlink changes are rejected", () => {
  for (const path of [
    ".github/workflows/factory-agents.yml",
    "scripts/factory/policy.cjs",
    "scripts/tests/factory-policy.test.cjs",
    "src/CLAUDE.md",
    "AGENTS.md",
    ".env.local",
    "package.json",
    "yarn.lock",
    "render.yaml",
    "../escape",
    "/tmp/file",
    "src/../../escape",
    "src\\escape.ts",
  ])
    assert.throws(
      () => artifact.validateChanges([{ path, mode: "100644", content: "x" }]),
      /path|policy/i
    );
  assert.throws(
    () => artifact.validateChanges([{ path: "src/link", mode: "120000", content: "/tmp/secret" }]),
    /regular/i
  );
});
test("binary, large and secret-like generated files are refused before upload/publication", () => {
  for (const content of [
    "hello\0world",
    "x".repeat(200001),
    "sk-ant-oat01-" + "z".repeat(70),
    "postgresql://person:private-password@cloud.example/neondb",
  ])
    assert.throws(
      () => artifact.validateChanges([{ path: "src/result.ts", mode: "100644", content }]),
      /binary|size|secret/i
    );
});
test("review output must be structured, bounded, valid and bound to the expected head", () => {
  const result = { head, verdict: "pass", summary: "No blocking findings", findings: [] };
  assert.equal(artifact.validateReview(result, head).verdict, "pass");
  for (const bad of [
    { ...result, head: "b".repeat(40) },
    { ...result, verdict: "unknown" },
    { ...result, verdict: "pass", findings: [{ severity: "important", message: "broken" }] },
    { ...result, summary: "x".repeat(5001) },
    { ...result, fixture: true },
  ])
    assert.throws(() => artifact.validateReview(bad, head), /review/i);
});
test("GitHub credential formats are refused in source and every review text field", () => {
  for (const prefix of ["ghp_", "ghs_", "gho_", "ghu_", "ghr_", "github_pat_"]) {
    const token = prefix + "X".repeat(40);
    assert.equal(artifact.secretLike(token), true);
    assert.throws(
      () =>
        artifact.validateChanges([
          { path: "src/example.ts", mode: "100644", content: `export const token = '${token}';` },
        ]),
      /secret/i
    );
    assert.throws(
      () =>
        artifact.validateReview(
          {
            head,
            verdict: "pass",
            summary: token,
            findings: [],
          },
          head
        ),
      /review/i
    );
    assert.throws(
      () =>
        artifact.validateReview(
          {
            head,
            verdict: "changes_requested",
            summary: "Repair needed",
            findings: [{ severity: "important", message: token }],
          },
          head
        ),
      /review/i
    );
  }
});
