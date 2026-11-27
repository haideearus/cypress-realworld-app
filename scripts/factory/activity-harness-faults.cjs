const { randomUUID } = require("node:crypto");
const { ROOT } = require("./github.cjs");
const { REPOSITORY, BOT, BOT_ID } = require("./wake-contract.cjs");
const { HARNESS_FAULTS } = require("./activity-contract.cjs");

const WINDOW_MS = 24 * 60 * 60 * 1000;
const PRIORITY = "factory-priority";

function failureKeys(run, jobs) {
  if (run.conclusion !== "failure") return [];
  const ciJobs = jobs.filter((job) => ["verify", "app", "discovery_image"].includes(job.name));
  if (new Set(ciJobs.map((job) => job.name)).size !== ciJobs.length) return [];
  const failed = ciJobs.filter(
    (job) =>
      job.run_id === run.id &&
      job.run_attempt === run.run_attempt &&
      job.head_sha === run.head_sha &&
      job.status === "completed" &&
      job.conclusion === "failure" &&
      Array.isArray(job.steps)
  );
  if (!failed.some((job) => job.name === "verify")) return [];
  return ["ci-controller-validation", "ci-scanner-install"].filter((key) =>
    failed.some((job) => {
      const matched = job.steps.filter((step) => step.name === HARNESS_FAULTS[key].step);
      return (
        matched.length === 1 &&
        matched[0].status === "completed" &&
        matched[0].conclusion === "failure"
      );
    })
  );
}

function issuePayload(key, evidence) {
  const { title, step } = HARNESS_FAULTS[key];
  const gate = key === "review-gate-verifier";
  // All public text is fixed. The only inputs to the template are validated run numbers.
  const links = evidence.map(
    ({ runId }) =>
      `- [${gate ? "Dependency maintenance" : "Factory CI"} run ${runId}](https://github.com/${REPOSITORY}/actions/runs/${runId})`
  );
  return {
    title,
    body: [
      gate
        ? "The factory could not obtain a fresh required review gate in two verified dependency runs within 24 hours."
        : `A Factory CI job on main failed at **${step}** in two distinct first-attempt Factory CI runs within 24 hours.`,
      "",
      ...links,
      "",
      "Inspect the linked runs and handle the infrastructure repair through a dedicated harness change.",
      "",
      `<!-- factory-harness-fault:${key} -->`,
    ].join("\n"),
    labels: [PRIORITY],
  };
}

function matchesIssue(issue, payload) {
  return (
    Number.isSafeInteger(issue?.number) &&
    issue.number > 0 &&
    !issue.pull_request &&
    ["open", "closed"].includes(issue.state) &&
    issue.user?.login === BOT &&
    issue.user.id === BOT_ID &&
    issue.user.type === "Bot" &&
    issue.title === payload.title &&
    (issue.body === payload.body ||
      issue.body === payload.body.replace("A Factory CI job", "The `verify` job")) &&
    Array.isArray(issue.labels) &&
    issue.labels.some((label) => label?.name === PRIORITY) &&
    !issue.labels.some((label) => label?.name === "factory-ready")
  );
}

async function findIssue(api, payload) {
  const found = [];
  for (let page = 1; page <= 5; page++) {
    const rows = await api.request(
      "GET",
      `${ROOT}/issues?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=desc&per_page=100&page=${page}`
    );
    if (!Array.isArray(rows) || rows.length > 100) throw Error("Invalid harness ticket lookup");
    found.push(...rows.filter((row) => matchesIssue(row, payload)));
    if (found.length > 1) throw Error("Ambiguous harness ticket receipt");
    if (rows.length < 100) return found[0];
  }
  return found[0];
}

async function ensurePriority(api, ledger) {
  const route = `${ROOT}/labels/${PRIORITY}`;
  let label;
  try {
    label = await api.request("GET", route);
  } catch (error) {
    if (error.status !== 404) throw error;
    if ((await ledger.read()).state.stop) return false;
    try {
      label = await api.request("POST", `${ROOT}/labels`, {
        name: PRIORITY,
        color: "b60205",
        description: "High-priority factory maintenance",
      });
    } catch {
      label = await api.request("GET", route);
    }
  }
  if (label?.name !== PRIORITY) throw Error("Factory priority label was not acknowledged");
  return !(await ledger.read()).state.stop;
}

async function updateReceipt(store, key, claim, change) {
  return store.update((state) => {
    const row = state.harnessFaults[key];
    if (row.claim === claim) Object.assign(row, change, { claim: null });
    return { state };
  });
}

// Called with the observer's verified GitHub run, never transport or log text.
async function triageHarnessFaults({ api, store, ledger, run, jobs }) {
  const now = Date.now();
  const at = Date.parse(run.updated_at);
  const created = Date.parse(run.created_at);
  if (
    run.path !== ".github/workflows/factory-ci.yml" ||
    run.event !== "push" ||
    run.head_branch !== "main" ||
    run.run_attempt !== 1 ||
    run.status !== "completed" ||
    run.actor?.login !== run.triggering_actor?.login ||
    run.actor?.id !== run.triggering_actor?.id ||
    !(created >= now - WINDOW_MS && created <= at && at <= now) ||
    (await ledger.read()).state.stop
  )
    return;

  return recordHarnessFaults({ api, store, ledger, run, keys: failureKeys(run, jobs), now, at });
}

async function recordHarnessFaults({
  api,
  store,
  ledger,
  run,
  keys,
  now,
  at,
  allowMissing = false,
}) {
  let { state } = await store.read({ allowMissing });
  keys = keys.filter((key) => {
    const row = state.harnessFaults?.[key];
    return !row?.issue && !row?.claim;
  });
  const pending = Object.values(state.harnessFaults || {}).some((row) => row.claim);
  if (!keys.length && !pending) return;

  const claim = randomUUID();
  if (keys.length) {
    try {
      ({ state } = await store.update(
        (current) => {
          const faults = (current.harnessFaults ??= {});
          for (const key of keys) {
            const old = faults[key];
            if (old?.claim || old?.issue) continue;
            const recent = (old?.evidence ?? []).filter(
              (entry) => entry.at >= now - WINDOW_MS && entry.at <= now
            );
            if (!recent.some((entry) => entry.runId === run.id)) recent.push({ runId: run.id, at });
            const evidence = recent.sort((a, b) => a.at - b.at || a.runId - b.runId).slice(-2);
            faults[key] = { evidence, claim: evidence.length === 2 ? claim : null, issue: null };
          }
          return { state: current };
        },
        { allowMissing }
      ));
    } catch (error) {
      // A CAS response may disappear after commit. Only this nonce authorizes creation.
      ({ state } = await store.read());
      if (!Object.values(state.harnessFaults || {}).some((row) => row.claim === claim)) throw error;
    }
  }

  let unresolved = false;
  for (const [key, row] of Object.entries(state.harnessFaults || {})) {
    if (!row.claim) continue;
    const payload = issuePayload(key, row.evidence);
    try {
      let issue;
      if (row.claim === claim) {
        let ready = false;
        try {
          ready = await ensurePriority(api, ledger);
        } finally {
          // This observer can release its claim only while no issue request has been sent.
          if (!ready) await updateReceipt(store, key, claim, {});
        }
        if (!ready) continue;
        try {
          issue = await api.request("POST", `${ROOT}/issues`, payload);
        } catch {
          // Only GitHub can tell whether a create reached the server.
        }
      }
      if (!matchesIssue(issue, payload)) issue = await findIssue(api, payload);
      if (issue) await updateReceipt(store, key, row.claim, { issue: issue.number });
      else unresolved = true;
    } catch {
      unresolved = true;
    }
  }
  return unresolved ? "held" : "recorded";
}

module.exports = { triageHarnessFaults, recordHarnessFaults };
