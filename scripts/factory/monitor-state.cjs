const { ROOT } = require("./github.cjs");
const { REPOSITORY, SHA } = require("./policy.cjs");
const { UUID, validateMonitorProof, proofFromIncident } = require("./monitor-proof.cjs");
const MAX_INCIDENTS = 180;
const MAX_CREATIONS_PER_DAY = 2;
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  record(value) && Object.keys(value).sort().join(",") === keys.split(",").sort().join(",");
function emptyMonitorState() {
  return { version: 1, repository: REPOSITORY, active: null, incidents: {} };
}
function validateMonitorState(state) {
  if (
    !exact(state, "version,repository,active,incidents") ||
    state.version !== 1 ||
    state.repository !== REPOSITORY ||
    !record(state.incidents) ||
    Object.keys(state.incidents).length > MAX_INCIDENTS ||
    (state.active !== null &&
      (!UUID.test(state.active) || !Object.hasOwn(state.incidents, state.active)))
  )
    throw new Error("Invalid monitor registry");
  const issueIds = new Set();
  for (const [id, incident] of Object.entries(state.incidents)) {
    if (
      !UUID.test(id) ||
      !exact(incident, "id,at,day,phase,recovered,source,criteriaHash,issue") ||
      incident.id !== id ||
      !["pending", "open"].includes(incident.phase) ||
      typeof incident.recovered !== "boolean" ||
      typeof incident.at !== "string" ||
      !Number.isFinite(Date.parse(incident.at)) ||
      new Date(incident.at).toISOString() !== incident.at ||
      incident.day !== incident.at.slice(0, 10) ||
      !exact(incident.source, "runId,runAttempt,workflowSha") ||
      !validateMonitorProof({
        ...proofFromIncident(incident),
        issue: incident.issue === null ? 1 : incident.issue,
      }) ||
      (incident.phase === "pending"
        ? incident.issue !== null || incident.recovered
        : incident.issue === null) ||
      ((!incident.recovered || incident.phase === "pending") && state.active !== id) ||
      (incident.issue !== null && issueIds.has(incident.issue))
    )
      throw new Error("Invalid monitor incident");
    if (incident.issue !== null) issueIds.add(incident.issue);
  }
  return state;
}
class MonitorStore {
  constructor(api) {
    this.api = api;
  }
  async read() {
    let ref;
    try {
      ref = await this.api.request("GET", `${ROOT}/git/ref/heads/factory/monitor`);
    } catch (error) {
      if (error.status === 404) return { state: emptyMonitorState(), commit: null };
      throw error;
    }
    const commit = ref.object?.sha;
    if (typeof commit !== "string" || !SHA.test(commit)) throw new Error("Invalid monitor commit");
    const file = await this.api.request("GET", `${ROOT}/contents/monitor.json?ref=${commit}`);
    if (
      file.type !== "file" ||
      file.encoding !== "base64" ||
      typeof file.content !== "string" ||
      file.content.length > 1500000
    )
      throw new Error("Invalid monitor file");
    let state;
    try {
      state = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    } catch {
      throw new Error("Invalid monitor JSON");
    }
    return { state: validateMonitorState(state), commit };
  }
  async save(state, parent) {
    validateMonitorState(state);
    if (parent !== null && (typeof parent !== "string" || !SHA.test(parent)))
      throw new Error("Invalid monitor parent");
    const content = JSON.stringify(state, null, 2) + "\n";
    if (Buffer.byteLength(content) > 1000000) throw new Error("Monitor registry is full");
    const blob = await this.api.request("POST", `${ROOT}/git/blobs`, {
      content: Buffer.from(content).toString("base64"),
      encoding: "base64",
    });
    const tree = await this.api.request("POST", `${ROOT}/git/trees`, {
      tree: [{ path: "monitor.json", mode: "100644", type: "blob", sha: blob.sha }],
    });
    const commit = await this.api.request("POST", `${ROOT}/git/commits`, {
      message: "Record production monitor incident",
      tree: tree.sha,
      parents: parent ? [parent] : [],
    });
    if (!SHA.test(commit.sha || "")) throw new Error("Invalid monitor write response");
    const saved = parent
      ? await this.api.request("PATCH", `${ROOT}/git/refs/heads/factory/monitor`, {
          sha: commit.sha,
          force: false,
        })
      : await this.api.request("POST", `${ROOT}/git/refs`, {
          ref: "refs/heads/factory/monitor",
          sha: commit.sha,
        });
    if (saved.object?.sha !== commit.sha) throw new Error("Monitor write was not acknowledged");
    return commit.sha;
  }
}
module.exports = {
  MAX_INCIDENTS,
  MAX_CREATIONS_PER_DAY,
  emptyMonitorState,
  validateMonitorState,
  MonitorStore,
};
