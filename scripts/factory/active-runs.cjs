const { ROOT } = require("./github.cjs");
async function terminalParent(api, entry) {
  const run = await api.request(
    "GET",
    `${ROOT}/actions/runs/${entry.runId}/attempts/${entry.runAttempt}`
  );
  return (
    run.id === Number(entry.runId) &&
    run.run_attempt === entry.runAttempt &&
    run.status === "completed"
  );
}
module.exports = { terminalParent };
