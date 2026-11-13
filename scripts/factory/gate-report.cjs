const { REPOSITORY } = require("./policy.cjs");
const { ROOT } = require("./github.cjs");
const WORKFLOW = "factory-review-status.yml";

// The caller must first validate genuine current-head ledger proof. Only this
// fixed, model-free pull-request workflow can be refreshed, once automatically.
async function refreshGate(api, pr) {
  let runs;
  try {
    runs = await api.pages(
      `${ROOT}/actions/workflows/${WORKFLOW}/runs?event=pull_request&head_sha=${pr.head.sha}`,
      "workflow_runs"
    );
  } catch (error) {
    if (error.status === 404)
      return { refreshed: false, reason: "Native gate workflow unavailable" };
    throw error;
  }
  const matching = runs
    .filter(
      (r) =>
        Number.isSafeInteger(r.id) &&
        r.id > 0 &&
        r.path === `.github/workflows/${WORKFLOW}` &&
        r.event === "pull_request" &&
        r.head_sha === pr.head.sha &&
        r.repository?.full_name === REPOSITORY &&
        r.head_repository?.full_name === REPOSITORY &&
        r.pull_requests?.some((p) => p.number === pr.number)
    )
    .sort((a, b) => b.id - a.id);
  const run = matching[0];
  if (!run || run.status !== "completed" || run.conclusion !== "failure" || run.run_attempt !== 1)
    return { refreshed: false, reason: "No first-attempt failed native gate to refresh" };
  const current = await api.request("GET", `${ROOT}/pulls/${pr.number}`);
  if (
    current.state !== "open" ||
    current.head?.sha !== pr.head.sha ||
    current.head?.repo?.full_name !== REPOSITORY ||
    current.base?.ref !== "main"
  )
    throw new Error("PR head changed before gate refresh");
  await api.request("POST", `${ROOT}/actions/runs/${run.id}/rerun-failed-jobs`);
  return { refreshed: true, runId: run.id, reason: "Native gate refresh requested" };
}
module.exports = { refreshGate };
