const { ROOT } = require("./github.cjs");
const { REPOSITORY } = require("./policy.cjs");
const { criteriaHash } = require("./monitor-origin.cjs");

const isPublisher = (user) => user?.login === "github-actions[bot]" && user.type === "Bot";

// The functional workflow serializes publishers. A single editable comment keeps the
// original criteria hash usable by pickup, CI, review and production closure.
async function recordFunctionalRepeat(api, incident, issue, context) {
  if (
    issue.state !== "open" ||
    !isPublisher(issue.user) ||
    criteriaHash(issue) !== incident.criteriaHash ||
    BigInt(context.runId) <= BigInt(incident.source.runId)
  )
    return;
  const marker = `<!-- factory-functional-repeat:${incident.id} -->`;
  const body = [
    marker,
    `Confirmed again: \`${incident.functionalCheck}\` / \`${incident.functionalAssertion}\`.`,
    `Tested main: \`${context.workflowSha}\`.`,
    `Evidence: https://github.com/${REPOSITORY}/actions/runs/${context.runId}`,
  ].join("\n\n");
  const route = `${ROOT}/issues/${issue.number}/comments`;
  for (let page = 1; page <= 3; page++) {
    const comments = await api.request("GET", `${route}?per_page=100&page=${page}`);
    if (!Array.isArray(comments) || comments.length > 100) return "held";
    const existing = comments.find(
      (row) => isPublisher(row?.user) && row.body?.startsWith(marker + "\n\n")
    );
    if (!existing && comments.length === 100) continue;
    if (existing) {
      const lastRun = /\/actions\/runs\/([1-9]\d*)$/.exec(existing.body);
      if (!Number.isSafeInteger(existing.id) || existing.id < 1 || !lastRun) return "held";
      if (BigInt(lastRun[1]) >= BigInt(context.runId)) return "recorded";
    }
    const response = existing
      ? await api.request("PATCH", `${ROOT}/issues/comments/${existing.id}`, { body })
      : await api.request("POST", route, { body });
    return isPublisher(response?.user) && response.body === body ? "recorded" : "held";
  }
  return "held";
}

module.exports = { recordFunctionalRepeat };
