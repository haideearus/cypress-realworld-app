// Owner-approved single case (#42). No runtime ignore list or variable override.
const CASE = Object.freeze({
  id: 43467058965,
  repository: "haideearus/cypress-realworld-app",
  workflow_id: 417450610,
  path: ".github/workflows/factory-automatic.yml",
  head_sha: "421553c2c108dc2704ef6cec7864582b8c63ead6",
  head_branch: "main",
  event: "workflow_dispatch",
  run_attempt: 1,
  status: "queued",
  conclusion: null,
  created_at: "2026-11-13T16:52:25Z",
  updated_at: "2026-11-13T16:52:25Z",
  run_started_at: "2026-11-13T16:52:25Z",
  check_suite_id: 117701182775,
});
const SOURCE_SHA256 = Object.freeze({
  "scripts/factory/policy.cjs": "d830c05c0e2ed507f57707d7bb98f8797b5195abea83c972e2008148687688b0",
  "scripts/factory/recovery.cjs":
    "52ae5020f37b79d0f0ab0e0f8a668e51c69cffb9c1269c048ed9d52da708a646",
  "scripts/factory/automation.cjs":
    "adb2ac07d34f85ef7f8d26b5c463300cbd8de8acd9e802e4741a208446f0ef9e",
  "scripts/factory/github.cjs": "2eb90167a5ddb8ae632e750885a45ca30c1e3a3418784e671e775469f58dc4ce",
  ".github/workflows/factory-automatic.yml":
    "208801d0a3ddf3d19e3f523e3e8cecc8ac591dc56dc995599a810ad5413e7991",
});
function denyRetiredRun(runId) {
  if (String(runId) === String(CASE.id)) throw new Error("Quarantined legacy run ID is denied");
}
module.exports = { CASE, SOURCE_SHA256, denyRetiredRun };
