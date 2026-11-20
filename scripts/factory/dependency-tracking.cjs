const policy = require("./policy.cjs");
const dependency = require("./dependency-contract.cjs");
const { Ledger, ROOT } = require("./github.cjs");
const { MetadataStore } = require("./metadata-store.cjs");

const READY_LABEL = "factory-dependency-ready";
const LIMIT = 500;
const PUBLICATIONS_PER_RUN = 5;
const INSPECTIONS_PER_RUN = 12;
const BUDGET_MS = 60_000;
const ALLOW_MISSING = { allowMissing: true };
const validNumber = (n) => Number.isSafeInteger(n) && n > 0;
const empty = () => ({ version: 1, records: {} });
class TrackingDeadline extends Error {}

function validate(state) {
  if (
    state?.version !== 1 ||
    !state.records ||
    Array.isArray(state.records) ||
    typeof state.records !== "object" ||
    Object.keys(state.records).length > LIMIT
  )
    throw Error("Invalid native dependency registry");
  const issues = new Set();
  for (const [number, row] of Object.entries(state.records)) {
    if (
      !validNumber(Number(number)) ||
      String(Number(number)) !== number ||
      !row ||
      Object.keys(row).some((key) => !["branch", "issue", "status", "rejected"].includes(key)) ||
      !dependency.branch(row.branch) ||
      !["intent", "open", "closing", "closed", "merged"].includes(row.status) ||
      (row.rejected !== undefined &&
        (row.status !== "intent" || ![403, 422].includes(row.rejected))) ||
      (row.status === "intent"
        ? row.issue !== null
        : !validNumber(row.issue) || String(row.issue) === number || issues.has(row.issue))
    )
      throw Error("Invalid native dependency ticket receipt");
    if (row.issue) issues.add(row.issue);
  }
  return state;
}

const title = (pr) => `Dependency maintenance for Dependabot PR #${pr}`;
const body = (pr) =>
  `Track [Dependabot PR #${pr}](https://github.com/${policy.REPOSITORY}/pull/${pr}). Dependency maintenance verifies the current proposal through its protected analysis, CI, review and merge workflow.\n\n<!-- factory-native-dependency:${pr} -->`;

function issueOK(issue, pr, number) {
  return (
    validNumber(issue?.number) &&
    issue.number !== pr &&
    (number === null || issue.number === number) &&
    ["open", "closed"].includes(issue.state) &&
    !issue.pull_request &&
    issue.user?.login === "github-actions[bot]" &&
    issue.user.id === 41898282 &&
    issue.user.type === "Bot" &&
    issue.title === title(pr) &&
    issue.body === body(pr) &&
    Array.isArray(issue.labels) &&
    issue.labels.some((label) => label?.name === READY_LABEL) &&
    !issue.labels.some((label) => label?.name === "factory-ready")
  );
}

function nativePR(row, closed = false) {
  try {
    // No configuration opts generated alert proposals into native tracking.
    return dependency.prOK(row, closed);
  } catch {
    return null;
  }
}

async function openProposals(api) {
  const proposals = new Map();
  for (let page = 1; page <= 5; page++) {
    const rows = await api.request(
      "GET",
      `${ROOT}/pulls?state=open&base=main&sort=created&direction=asc&per_page=100&page=${page}`
    );
    if (!Array.isArray(rows) || rows.length > 100) throw Error("Invalid bounded dependency queue");
    for (const row of rows) {
      if (nativePR(row)) proposals.set(row.number, row);
    }
    if (rows.length < 100) break;
  }
  return proposals;
}

function inspectionBatch(rows, now) {
  if (rows.length <= INSPECTIONS_PER_RUN) return rows;
  const batches = Math.ceil(rows.length / INSPECTIONS_PER_RUN);
  const start = (Math.floor(now / 3_600_000) % batches) * INSPECTIONS_PER_RUN;
  return rows.slice(start, start + INSPECTIONS_PER_RUN);
}

async function recoveryIssues(api) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const rows = await api.request(
      "GET",
      `${ROOT}/issues?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=desc&per_page=100&page=${page}`
    );
    if (!Array.isArray(rows) || rows.length > 100) throw Error("Invalid bounded issue response");
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  // Incomplete evidence cannot establish an exact single issue.
  return [];
}

async function readExisting(api, path) {
  try {
    return await api.request("GET", path);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function currentPR(api, number, branch, closed = false) {
  const pr = nativePR(await readExisting(api, `${ROOT}/pulls/${number}`), closed);
  return pr &&
    pr.number === number &&
    pr.head.ref === branch &&
    (pr.state === "open" ? pr.merged === false : typeof pr.merged === "boolean")
    ? pr
    : null;
}

async function eligible(api, proposal) {
  const pr = await currentPR(api, proposal.number, proposal.head.ref);
  if (!pr) return false;
  const files = await api.request("GET", `${ROOT}/pulls/${pr.number}/files?per_page=3`);
  try {
    dependency.filesOK(files);
  } catch {
    return false;
  }
  const fresh = await currentPR(api, pr.number, pr.head.ref);
  return fresh?.head.sha === pr.head.sha;
}

async function ensureLabel(api, beforeWrite) {
  const path = `${ROOT}/labels/${READY_LABEL}`;
  try {
    const label = await api.request("GET", path);
    if (label.name !== READY_LABEL) throw Error("Unexpected dependency label");
  } catch (error) {
    if (error.status !== 404) throw error;
    await beforeWrite();
    try {
      const label = await api.request("POST", `${ROOT}/labels`, {
        name: READY_LABEL,
        color: "b60205",
        description: "Factory dependency maintenance",
      });
      if (label.name !== READY_LABEL) throw Error("Dependency label was not acknowledged");
    } catch (writeError) {
      if (writeError.status !== 422 || (await api.request("GET", path)).name !== READY_LABEL)
        throw writeError;
    }
  }
}

async function advance(store, number, expected, next, beforeWrite) {
  const result = await store.update(async (state) => {
    const existing = state.records[number];
    if (JSON.stringify(existing) !== JSON.stringify(expected))
      throw Error("Native dependency ticket receipt changed concurrently");
    await beforeWrite();
    state.records[number] = next;
    return { state, row: next };
  }, ALLOW_MISSING);
  return result.row;
}

async function syncIssue(api, number, issue, state, stateReason, beforeWrite) {
  if (!issueOK(issue, number, issue?.number)) return false;
  if (issue.state === state) return true;
  await beforeWrite();
  try {
    const updated = await api.request("PATCH", `${ROOT}/issues/${issue.number}`, {
      state,
      state_reason: stateReason,
    });
    return (
      issueOK(updated, number, issue.number) &&
      updated.state === state &&
      (state === "open" || updated.state_reason === stateReason)
    );
  } catch (error) {
    if (error instanceof TrackingDeadline) throw error;
    // The next run confirms the outcome from GitHub before applying an update.
    return false;
  }
}

async function syncKnown(api, store, number, row, pr, beforeWrite) {
  if (pr.state === "open" && row.status === "open") return "unchanged";
  const issue = await readExisting(api, `${ROOT}/issues/${row.issue}`);
  if (!issueOK(issue, number, row.issue)) return "held";
  if (pr.state === "closed" && row.status !== "closing")
    row = await advance(store, number, row, { ...row, status: "closing" }, beforeWrite);
  const open = pr.state === "open";
  const outcome = open ? "open" : pr.merged ? "merged" : "closed";
  const reason = open ? "reopened" : pr.merged ? "completed" : "not_planned";
  const fresh = await currentPR(api, number, row.branch, true);
  if (fresh?.state !== pr.state || fresh.merged !== pr.merged) return "held";
  if (!(await syncIssue(api, number, issue, pr.state, reason, beforeWrite))) return "held";
  await advance(store, number, row, { ...row, status: outcome }, beforeWrite);
  return open ? "reopened" : "closed";
}

async function track(api, preview, now, result, links) {
  const ledger = new Ledger(api);
  const beforeWrite = async () => policy.assertNotStopped((await ledger.read()).state);
  if ((await ledger.read()).state.stop)
    return "Factory stopped; native dependency tracking is paused";
  const store = new MetadataStore(api, "dependency-tracking", empty, validate);
  const { state } = await store.read(ALLOW_MISSING);
  const proposals = await openProposals(api);
  const untracked = [...proposals.values()].filter((pr) => !state.records[pr.number]);
  const candidates = inspectionBatch(untracked, now);
  if (preview) {
    for (const pr of candidates) {
      if (await eligible(api, pr)) links.set(pr.number, { pr: pr.number, status: "would track" });
      if (links.size === PUBLICATIONS_PER_RUN) break;
    }
    return links.size
      ? `Native dependency tracking would publish ${links.size} issue(s).`
      : "No new eligible native dependency tracking issues in this bounded scan.";
  }

  const sync = Object.entries(state.records).filter(([key, row]) => {
    const open = proposals.has(Number(key));
    return (
      row.status === "intent" ||
      row.status === "closing" ||
      (row.status === "open" && !open) ||
      (row.status === "closed" && open)
    );
  });
  let issues;
  for (const [key, saved] of inspectionBatch(sync, now)) {
    const number = Number(key);
    const pr = await currentPR(api, number, saved.branch, true);
    if (!pr) {
      result.held++;
      links.set(number, { pr: number, issue: saved.issue, status: "PR identity unavailable" });
      continue;
    }
    let row = saved;
    if (row.status === "intent") {
      issues ??= await recoveryIssues(api);
      const matches = issues.filter((issue) => issueOK(issue, number, null));
      if (matches.length !== 1) {
        result.held++;
        links.set(number, {
          pr: number,
          status: row.rejected
            ? `GitHub rejected issue creation (HTTP ${row.rejected})`
            : "issue creation requires reconciliation",
        });
        continue;
      }
      const status = matches[0].state === "open" ? "open" : "closing";
      row = await advance(
        store,
        number,
        row,
        { branch: row.branch, status, issue: matches[0].number },
        beforeWrite
      );
      result.reconciled++;
      links.set(number, { pr: number, issue: row.issue, status: "reconciled" });
    }
    const action = await syncKnown(api, store, number, row, pr, beforeWrite);
    if (action !== "unchanged") {
      result[action]++;
      links.set(number, {
        pr: number,
        issue: row.issue,
        status: pr.merged && action === "closed" ? "merged" : action,
      });
    }
  }
  let attempts = 0;
  for (const proposal of candidates) {
    if (!(await eligible(api, proposal))) {
      result.held++;
      continue;
    }
    if (attempts === 0) await ensureLabel(api, beforeWrite);
    const number = proposal.number;
    const saved = await advance(
      store,
      number,
      undefined,
      { branch: proposal.head.ref, issue: null, status: "intent" },
      beforeWrite
    );
    attempts++;
    await beforeWrite();
    let issue;
    try {
      issue = await api.request("POST", `${ROOT}/issues`, {
        title: title(number),
        body: body(number),
        labels: [READY_LABEL],
      });
    } catch (error) {
      if (error instanceof TrackingDeadline) throw error;
      if ([403, 422].includes(error.status)) {
        await advance(store, number, saved, { ...saved, rejected: error.status }, beforeWrite);
        links.set(number, {
          pr: number,
          status: `GitHub rejected issue creation (HTTP ${error.status})`,
        });
        result.rejected++;
      }
      // Keep the intent after an uncertain write. Only exact issue reconciliation may advance it.
    }
    if (issueOK(issue, number, null) && issue.state === "open") {
      await advance(
        store,
        number,
        saved,
        { ...saved, issue: issue.number, status: "open" },
        beforeWrite
      );
      result.published++;
      links.set(number, { pr: number, issue: issue.number, status: "opened" });
    } else {
      result.held++;
      if (!links.has(number))
        links.set(number, { pr: number, status: "issue creation requires reconciliation" });
    }
    if (attempts === PUBLICATIONS_PER_RUN) break;
  }
  for (const [number, row] of Object.entries(state.records)) {
    const pr = Number(number);
    if (links.size >= 10) break;
    if (row.status === "open" && proposals.has(pr) && !links.has(pr))
      links.set(pr, { pr, issue: row.issue, status: "tracked" });
  }
}

async function trackNativeDependencies(api, config, context, preview) {
  policy.authorize(context);
  if (!dependency.contextOK(context) || typeof preview !== "boolean")
    throw Error("Unauthorized native dependency tracking");
  if (!preview && (!config.enabled || !config.automatic))
    return { reason: "Native dependency tracking is disabled" };
  const now = Date.now();
  const bounded = {
    request(method, path, data) {
      if (Date.now() >= now + BUDGET_MS) throw new TrackingDeadline();
      return api.request(method, path, data);
    },
  };
  const result = { published: 0, reconciled: 0, closed: 0, reopened: 0, held: 0, rejected: 0 };
  const links = new Map();
  let reason;
  try {
    reason = await track(bounded, preview, now, result, links);
  } catch (error) {
    if (!(error instanceof TrackingDeadline)) throw error;
    reason =
      "Native dependency tracking reached its time budget. Unfinished receipts remain recorded.";
  }
  return {
    ...result,
    links: [...links.values()].slice(0, 10),
    reason:
      reason ||
      `Native Dependabot tracking published ${result.published}, reconciled ${result.reconciled}, closed ${result.closed}, ` +
        `reopened ${result.reopened} and held ${result.held} issue(s). Definite GitHub rejections ${result.rejected}.`,
  };
}

module.exports = { trackNativeDependencies };
