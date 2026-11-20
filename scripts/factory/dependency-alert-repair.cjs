const fs = require("node:fs");
const path = require("node:path");
const policy = require("./policy.cjs");
const d = require("./dependency-contract.cjs");
const slots = require("./active-tickets.cjs");
const { terminalParent } = require("./active-runs.cjs");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const { MetadataStore } = require("./metadata-store.cjs");
const { inspectUpdate, queryOsv, toolsAt } = require("./dependency-analysis.cjs");
const { preview, listAlerts, readJSON } = require("./dependency-alerts.cjs");

const READY_LABEL = "factory-dependency-ready";
const HELD_LABEL = "factory-dependency-held";
const PKG = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PUBLISH_PHASES = ["prepared", "issue-intent", "issue", "pr-intent", "linked"];
const PHASES = [...PUBLISH_PHASES, "ready", "refresh", "resolved", "held"];
const TRACKING_PHASES = ["tracking-intent", "tracking", "tracking-uncertain"];
const TRACKING_REASONS = {
  "selector-held": [
    "A patched release is outside an existing lockfile selector.",
    "Identify the direct pin or parent dependency that sets the range and prepare a reviewed update.",
  ],
  "major-held": [
    "The available patched releases require a major version update.",
    "Review compatibility and prepare a tested direct or parent dependency upgrade.",
  ],
  "no-common-candidate": [
    "There is no single verified patched release for the affected lockfile selections.",
    "Check the affected release lines and prepare a tested update for each selection that needs one.",
  ],
  "advisory-held": [
    "Advisory evidence is incomplete or cannot establish a patched release.",
    "Confirm the affected versions and patched versions using reviewed advisories before proposing a change.",
  ],
  "metadata-held": [
    "The advisory catalog or registry evidence was unavailable or incomplete.",
    "Recheck the advisory and registry metadata before proposing a change.",
  ],
  "graph-held": [
    "The candidate would change the dependency graph or a pinned lockfile selection.",
    "Trace the dependency through the direct pin or parent package and prepare a tested update.",
  ],
  "candidate-held": [
    "The compatible release lacks complete lockfile or vulnerability clearance evidence.",
    "Verify the exact release, lockfile change and advisory clearance before proposing a repair.",
  ],
};
const WORKFLOW_FILE = ".github/workflows/factory-dependency-alerts.yml";
const validId = (n) => Number.isSafeInteger(n) && n > 0;
const empty = () => ({ version: 1, cursor: 0, records: {} });
class UncertainPublication extends Error {}
class AlertAdmissionHold extends Error {}
class CandidateGraphHold extends Error {}

function validate(state) {
  if (
    state?.version !== 1 ||
    !Number.isSafeInteger(state.cursor) ||
    state.cursor < 0 ||
    state.cursor > 500 ||
    !state.records ||
    Array.isArray(state.records) ||
    typeof state.records !== "object" ||
    Object.keys(state.records).length > 500
  )
    throw Error("Invalid dependency alert registry");
  const issues = new Set(),
    prs = new Set();
  for (const [key, row] of Object.entries(state.records)) {
    const hasTrackingReason = Object.hasOwn(TRACKING_REASONS, row?.trackingReason);
    if (
      !d.HASH.test(key) ||
      typeof row?.name !== "string" ||
      row.name.length > 214 ||
      !PKG.test(row.name) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.day || "") ||
      (row.trackingReason !== undefined && !hasTrackingReason)
    )
      throw Error("Invalid dependency alert receipt");
    if (TRACKING_PHASES.includes(row.phase)) {
      if (
        !hasTrackingReason ||
        row.candidate !== undefined ||
        row.base !== undefined ||
        row.head !== undefined ||
        row.hold !== undefined ||
        row.refresh !== undefined ||
        row.pr !== null ||
        (row.phase === "tracking"
          ? !validId(row.issue) || issues.has(row.issue)
          : row.issue !== null)
      )
        throw Error("Invalid held dependency alert receipt");
      if (row.issue) issues.add(row.issue);
      continue;
    }
    const phase = PHASES.indexOf(row?.phase);
    const identityPhase = row?.phase === "refresh" ? PHASES.indexOf(row.refresh?.resume) : phase;
    const hasIssue = identityPhase >= 2 && (row.phase !== "held" || row.issue !== null);
    const hasPR = identityPhase >= 4 && (row.phase !== "held" || row.pr !== null);
    if (
      phase < 0 ||
      typeof row.candidate !== "string" ||
      !RELEASE.test(row.candidate) ||
      !d.SHA.test(row.base || "") ||
      !d.SHA.test(row.head || "") ||
      row.base === row.head ||
      (row.phase === "held"
        ? !["stale-base", "publication-uncertain"].includes(row.hold)
        : row.hold !== undefined) ||
      (hasIssue ? !validId(row.issue) || issues.has(row.issue) : row.issue !== null) ||
      (hasPR ? !validId(row.pr) || !hasIssue || prs.has(row.pr) : row.pr !== null) ||
      (row.phase === "refresh"
        ? !["prepared", "issue", "linked", "ready"].includes(row.refresh?.resume) ||
          !d.SHA.test(row.refresh?.base || "") ||
          !d.SHA.test(row.refresh?.head || "") ||
          row.refresh.head === row.head ||
          row.refresh.base === row.base
        : row.refresh !== undefined)
    )
      throw Error("Invalid dependency alert receipt");
    if (row.issue) issues.add(row.issue);
    if (row.pr) prs.add(row.pr);
  }
  return state;
}

const storeFor = (api) => new MetadataStore(api, "dependency-alerts", empty, validate);
const pullTitle = (r) => `Security maintenance: update ${r.name} to ${r.candidate}`;
const issueTitle = (r) =>
  r.trackingReason ? `Security maintenance: investigate ${r.name}` : pullTitle(r);
function issueBody(key, row) {
  const marker = `<!-- factory-dependency-alert:${key} -->`;
  if (row.trackingReason) {
    const [reason, action] = TRACKING_REASONS[row.trackingReason];
    return `Track an open vulnerability for \`${row.name}\` in the Yarn lockfile.\n\nInitial hold: ${reason}\n\nNext step: ${action}\n\nThe factory will add \`${READY_LABEL}\` after it verifies a compatible lockfile repair and links its proposal.\n\n${marker}`;
  }
  return `Update \`${row.name}\` to \`${row.candidate}\` within the existing version range. The factory will verify the exact update with dependency analysis, CI and independent review.\n\n${marker}`;
}
const linkedIssueBody = (key, row) =>
  `${issueBody(key, row)}\n\nRepair proposal [#${row.pr}](https://github.com/${d.REPOSITORY}/pull/${row.pr}).`;
const pullBody = (r) =>
  `Tracks #${r.issue}.\n\nApply the prepared Yarn lockfile update for \`${r.name}\` \`${r.candidate}\`.`;

function issueOK(issue, key, row, ready = true) {
  const original = issueBody(key, row);
  const linked = row.trackingReason && row.pr ? linkedIssueBody(key, row) : original;
  return (
    validId(issue?.number) &&
    (!row.issue || row.issue === issue.number) &&
    issue.state === "open" &&
    !issue.pull_request &&
    issue.user?.login === "github-actions[bot]" &&
    issue.user.id === 41898282 &&
    issue.title === issueTitle(row) &&
    (issue.body === linked || (!ready && issue.body === original)) &&
    (!ready || (hasLabel(issue, READY_LABEL) && !hasLabel(issue, HELD_LABEL)))
  );
}

const hasLabel = (issue, name) => issue.labels?.some((label) => label.name === name);

async function verifyAlertPR(api, pr, config, store = storeFor(api), reconcile = false) {
  const key = d.alertKey(pr?.head?.ref);
  if (!key) return null;
  d.prOK(pr, true, config);
  const row = (await store.read()).state.records[key];
  if (
    !row ||
    !["ready", "resolved"].includes(row.phase) ||
    row.pr !== pr.number ||
    row.head !== pr.head.sha ||
    (pr.state === "open" && !reconcile && row.base !== pr.base.sha)
  )
    throw Error("Dependency alert proposal has no matching receipt");
  if (pr.state === "open" && !reconcile) {
    const issue = await api.request("GET", `${ROOT}/issues/${row.issue}`);
    if (!issueOK(issue, key, row))
      throw new AlertAdmissionHold("Dependency alert ticket is held or changed");
  }
  return row;
}

function sortedMap(value = {}) {
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function patchLock(lock, plan, release, tools) {
  const { lockfile, semver } = tools;
  const parsed = lockfile.parse(lock);
  if (parsed.type !== "success" || lockfile.stringify(parsed.object) !== lock)
    throw Error("Yarn lockfile cannot be round-tripped");
  const { package: name, candidate } = plan;
  const tarball = `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${candidate}.tgz`;
  const dist = release?.dist;
  if (
    !PKG.test(name) ||
    !RELEASE.test(candidate) ||
    release?.name !== name ||
    release.version !== candidate ||
    dist?.tarball !== tarball ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity || "") ||
    !d.SHA.test(dist.shasum || "")
  )
    throw Error("Invalid npm registry release");
  let changed = 0;
  for (const [selector, entry] of Object.entries(parsed.object)) {
    const alias = selector.includes("@npm:");
    const target = alias ? selector.split("@npm:").at(-1) : selector;
    if (!target.startsWith(name + "@") || !plan.locked.includes(entry.version)) continue;
    if (
      alias ||
      !semver.satisfies(candidate, target.slice(name.length + 1)) ||
      semver.major(candidate) !== semver.major(entry.version) ||
      !semver.gt(candidate, entry.version) ||
      sortedMap(entry.dependencies) !== sortedMap(release.dependencies) ||
      sortedMap(entry.optionalDependencies) !== sortedMap(release.optionalDependencies)
    )
      throw new CandidateGraphHold(
        "Update would change the dependency graph or a pinned selection"
      );
    parsed.object[selector] = {
      ...entry,
      version: candidate,
      resolved: tarball + "#" + dist.shasum,
      integrity: dist.integrity,
    };
    changed++;
  }
  if (!changed) throw Error("No affected lockfile selection");
  return lockfile.stringify(parsed.object);
}

async function current(api, base) {
  const { state } = await new Ledger(api).read();
  policy.assertNotStopped(state);
  const ref = await api.request("GET", `${ROOT}/git/ref/heads/main`);
  if (ref.object?.sha !== base) throw Error("Dependency alert preparation is stale");
  return state;
}

async function makeCommit(api, base, lock, previous) {
  const parent = await api.request("GET", `${ROOT}/git/commits/${base}`);
  if (!d.SHA.test(parent.tree?.sha || "")) throw Error("Missing base tree");
  const blob = await api.request("POST", `${ROOT}/git/blobs`, {
    encoding: "base64",
    content: Buffer.from(lock).toString("base64"),
  });
  const tree = await api.request("POST", `${ROOT}/git/trees`, {
    base_tree: parent.tree.sha,
    tree: [{ path: "yarn.lock", mode: "100644", type: "blob", sha: blob.sha }],
  });
  const commit = await api.request("POST", `${ROOT}/git/commits`, {
    message: "Update locked dependency to a patched version",
    tree: tree.sha,
    parents: previous ? [base, previous] : [base],
  });
  if (!d.SHA.test(commit.sha || "")) throw Error("Invalid dependency commit");
  return commit.sha;
}

async function advance(store, key, row, patch) {
  const { saved } = await store.update((state) => {
    if (JSON.stringify(state.records[key]) !== JSON.stringify(row))
      throw Error("Dependency alert receipt changed concurrently");
    const saved = (state.records[key] = { ...row, ...patch });
    return { state, saved };
  });
  return saved;
}

const openRecord = (registry, name) =>
  Object.entries(registry.records).find(([, row]) => row.name === name && row.phase !== "resolved");

async function addRecord(store, key, row) {
  const { saved } = await store.update((state) => {
    if (state.records[key] || openRecord(state, row.name))
      throw Error("Dependency alert already tracked");
    state.records[key] = row;
    return { state, saved: row };
  });
  return saved;
}

async function issueMatching(api, key, row) {
  const issues = await api.pages(`${ROOT}/issues?state=all&sort=created&direction=desc`);
  const matches = issues.filter((i) => issueOK(i, key, row, false));
  if (matches.length !== 1)
    throw new UncertainPublication("Dependency alert issue creation requires reconciliation");
  return matches[0];
}

async function ensureRef(api, ref, head) {
  let result;
  try {
    result = await api.request("GET", `${ROOT}/git/ref/heads/${ref}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    result = await api.request("POST", `${ROOT}/git/refs`, { ref: `refs/heads/${ref}`, sha: head });
  }
  if (result.object?.sha !== head) throw Error("Dependency alert branch changed");
}

async function ensureLabel(api, name, color, description) {
  const endpoint = `${ROOT}/labels/${name}`;
  let label;
  try {
    label = await api.request("GET", endpoint);
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      label = await api.request("POST", `${ROOT}/labels`, { name, color, description });
    } catch (conflict) {
      if (![409, 422].includes(conflict.status)) throw conflict;
      label = await api.request("GET", endpoint);
    }
  }
  if (label?.name !== name) throw Error("Dependency alert label not acknowledged");
}

function trackingIssueOK(issue, key, row) {
  return (
    issueOK(issue, key, row, false) && hasLabel(issue, HELD_LABEL) && !hasLabel(issue, READY_LABEL)
  );
}

async function postTrackingIssue(api, store, base, key, row) {
  await current(api, base);
  const issue = await api.request("POST", `${ROOT}/issues`, {
    title: issueTitle(row),
    body: issueBody(key, row),
    labels: [HELD_LABEL],
  });
  if (!trackingIssueOK(issue, key, row)) throw Error("Held dependency issue not acknowledged");
  await advance(store, key, row, { phase: "tracking", issue: issue.number });
  return { outcome: "tracked-held", issue: issue.number };
}

async function recoverTrackingIssue(api, store, base, key, row) {
  try {
    const issue = await issueMatching(api, key, row);
    if (!trackingIssueOK(issue, key, row))
      throw new UncertainPublication("Held dependency issue requires reconciliation");
    await current(api, base);
    await advance(store, key, row, { phase: "tracking", issue: issue.number });
    return { outcome: "tracked-held", issue: issue.number };
  } catch (error) {
    if (!(error instanceof UncertainPublication)) throw error;
    await current(api, base);
    await advance(store, key, row, { phase: "tracking-uncertain" });
    return { outcome: "held-publication-uncertain" };
  }
}

async function publish(api, app, config, store, key, row) {
  const ref = d.alertBranch(key);
  await current(api, row.base);
  await ensureRef(api, ref, row.head);
  if (row.phase === "prepared") {
    row = await advance(store, key, row, { phase: "issue-intent" });
    await current(api, row.base);
    const issue = await api.request("POST", `${ROOT}/issues`, {
      title: issueTitle(row),
      body: issueBody(key, row),
      labels: [],
    });
    if (!issueOK(issue, key, row, false)) throw Error("Issue creation not acknowledged");
    row = await advance(store, key, row, { phase: "issue", issue: issue.number });
  } else if (row.phase === "issue-intent") {
    const issue = await issueMatching(api, key, row);
    row = await advance(store, key, row, { phase: "issue", issue: issue.number });
  }
  async function link(pr) {
    d.prOK(pr, false, config);
    if (
      pr.head.ref !== ref ||
      pr.head.sha !== row.head ||
      pr.base.sha !== row.base ||
      pr.body !== pullBody(row) ||
      pr.title !== pullTitle(row)
    )
      throw Error("Dependency PR creation not acknowledged");
    return advance(store, key, row, { phase: "linked", pr: pr.number });
  }
  if (row.phase === "issue") {
    if (row.trackingReason) {
      const issue = await api.request("GET", `${ROOT}/issues/${row.issue}`);
      if (!trackingIssueOK(issue, key, row)) throw Error("Held dependency issue changed");
    }
    row = await advance(store, key, row, { phase: "pr-intent" });
    await current(api, row.base);
    row = await link(
      await app.request("POST", `${ROOT}/pulls`, {
        title: pullTitle(row),
        body: pullBody(row),
        base: "main",
        head: ref,
        draft: false,
      })
    );
  } else if (row.phase === "pr-intent") {
    const rows = await api.pages(`${ROOT}/pulls?state=open&head=${policy.OWNER}:${ref}`);
    if (rows.length !== 1)
      throw new UncertainPublication("Dependency alert PR creation requires reconciliation");
    row = await link(rows[0]);
  }
  await current(api, row.base);
  let issue = await api.request("GET", `${ROOT}/issues/${row.issue}`);
  if (!issueOK(issue, key, row, false)) throw Error("Dependency alert ticket changed");
  if (row.trackingReason) {
    const body = linkedIssueBody(key, row);
    if (issue.body !== body) {
      await current(api, row.base);
      issue = await api.request("PATCH", `${ROOT}/issues/${row.issue}`, { body });
      if (issue.body !== body || !issueOK(issue, key, row, false))
        throw Error("Dependency issue link not acknowledged");
    }
  }
  if (!hasLabel(issue, READY_LABEL))
    await ensureLabel(api, READY_LABEL, "b60205", "Verified factory dependency update");
  if (row.trackingReason && hasLabel(issue, HELD_LABEL)) {
    await current(api, row.base);
    const remaining = await api.request(
      "DELETE",
      `${ROOT}/issues/${row.issue}/labels/${HELD_LABEL}`
    );
    if (!Array.isArray(remaining) || remaining.some((label) => label.name === HELD_LABEL))
      throw Error("Held dependency label removal not acknowledged");
  }
  if (!hasLabel(issue, READY_LABEL)) {
    await current(api, row.base);
    const labels = await api.request("POST", `${ROOT}/issues/${row.issue}/labels`, {
      labels: [READY_LABEL],
    });
    if (
      !Array.isArray(labels) ||
      !hasLabel({ labels }, READY_LABEL) ||
      hasLabel({ labels }, HELD_LABEL)
    )
      throw Error("Ready dependency label not acknowledged");
  }
  return advance(store, key, row, { phase: "ready" });
}

async function buildCandidate(plan, lock, manifest, tools, transport) {
  if (plan?.status !== "compatible-candidate") return { reason: plan?.holdReason || plan?.status };
  try {
    const { body } = await readJSON(
      new URL(`https://registry.npmjs.org/${encodeURIComponent(plan.package)}/${plan.candidate}`),
      transport
    );
    const candidate = patchLock(lock, plan, body, tools);
    const details = inspectUpdate(manifest, manifest, lock, candidate, tools);
    if ((await queryOsv(details.queries, transport)).cleared.length) return { candidate };
  } catch (error) {
    if (error instanceof CandidateGraphHold) return { reason: "graph-held" };
  }
  return { reason: "candidate-held" };
}

async function finishRefresh(api, app, store, base, key, row) {
  const ref = `${ROOT}/git/ref/heads/${d.alertBranch(key)}`;
  const { base: nextBase, head, resume } = row.refresh;
  const result = await api.request("GET", ref).catch((error) => {
    if (
      error.status === 404 &&
      (resume === "prepared" || (resume === "issue" && row.trackingReason))
    )
      return { object: { sha: null } };
    throw error;
  });
  const saved = { base: nextBase, head, phase: resume, refresh: undefined };
  if (result.object?.sha === row.refresh.head) {
    await advance(store, key, row, saved);
    return { outcome: "refreshed" };
  }
  if (result.object?.sha !== row.head && result.object?.sha !== null)
    throw Error("Dependency proposal head changed unexpectedly");
  if (nextBase !== base) {
    await advance(store, key, row, { phase: resume, refresh: undefined });
    return { outcome: "refresh-outdated" };
  }
  await current(api, base);
  if (result.object?.sha === null) {
    await ensureRef(api, d.alertBranch(key), head);
  } else {
    const updated = await app.request("PATCH", ref.replace("/git/ref/", "/git/refs/"), {
      sha: head,
      force: false,
    });
    if (updated.object?.sha !== head) throw Error("Dependency refresh not acknowledged");
  }
  await advance(store, key, row, saved);
  return { outcome: "refreshed" };
}

async function canRefresh(api, state, row) {
  const active = slots.activeEntries(state);
  const ticket = state.tickets[row.pr];
  return (
    !ticket?.merge &&
    (!active.length ||
      (active.length === 1 &&
        active[0].ticket === row.pr &&
        ticket?.status === "reviewed" &&
        (await terminalParent(api, active[0]))))
  );
}

async function verifyResolvedLock(api, row, lock, tools) {
  const { content } = require("./dependency-run.cjs");
  const before = tools.lockfile.parse(await content(api, row.base, "yarn.lock"));
  const after = tools.lockfile.parse(await content(api, row.head, "yarn.lock"));
  const currentLock = tools.lockfile.parse(lock);
  if ([before, after, currentLock].some((x) => x.type !== "success"))
    throw Error("Dependency merge evidence lockfile invalid");
  const updated = Object.keys(after.object).filter(
    (key) =>
      key.startsWith(row.name + "@") &&
      after.object[key].version === row.candidate &&
      before.object[key]?.version !== row.candidate
  );
  return (
    updated.length > 0 && updated.every((key) => currentLock.object[key]?.version === row.candidate)
  );
}

async function runRepair({
  api,
  app,
  store = storeFor(api),
  token,
  config,
  base,
  lock,
  manifest,
  tools,
  transport = fetch,
  now = new Date(),
}) {
  if (
    !config.enabled ||
    !config.automatic ||
    !config.alertRepair ||
    !config.minutes ||
    !config.turns ||
    !config.reviews
  )
    return { outcome: "disabled" };
  const state = await current(api, base);
  let registry;
  try {
    registry = (await store.read()).state;
  } catch (error) {
    if (error.status !== 404) throw error;
    await store.initialize();
    registry = (await store.read()).state;
  }
  if (slots.pendingIntent(state)) return { outcome: "factory-busy" };
  const refreshing = Object.entries(registry.records).find(([, row]) => row.phase === "refresh");
  if (refreshing && (await canRefresh(api, state, refreshing[1])))
    return finishRefresh(api, app, store, base, ...refreshing);
  const active = slots.activeEntries(state);
  const refresh = async (key, row) => {
    const { plans } = await preview(token, lock, tools, transport, { packageName: row.name });
    const plan = plans.find((p) => p.candidate === row.candidate);
    const { candidate } = await buildCandidate(plan, lock, manifest, tools, transport);
    if (!candidate) return null;
    await current(api, base);
    const head = await makeCommit(api, base, candidate, row.head);
    const next = await advance(store, key, row, {
      phase: "refresh",
      refresh: { base, head, resume: row.phase },
    });
    return finishRefresh(api, app, store, base, key, next);
  };
  const pending = active.length
    ? null
    : Object.entries(registry.records).find(
        ([, row]) => PUBLISH_PHASES.includes(row.phase) || row.phase === "tracking-intent"
      );
  if (pending) {
    const [key, row] = pending;
    if (row.phase === "tracking-intent") return recoverTrackingIssue(api, store, base, key, row);
    if (row.base !== base) {
      if (["prepared", "issue", "linked"].includes(row.phase)) {
        const recovered = await refresh(key, row);
        if (recovered) return recovered;
      }
      await advance(store, key, row, { phase: "held", hold: "stale-base" });
      return { outcome: "held-stale-preparation" };
    }
    try {
      const published = await publish(api, app, config, store, key, row);
      return { outcome: "published", issue: published.issue, pr: published.pr };
    } catch (error) {
      if (!(error instanceof UncertainPublication)) throw error;
      const latest = (await store.read()).state.records[key];
      await advance(store, key, latest, { phase: "held", hold: "publication-uncertain" });
      return { outcome: "held-publication-uncertain" };
    }
  }
  const linked = Object.entries(registry.records).filter(([, row]) => row.phase === "ready");
  let openAlerts;
  for (const [key, row] of linked) {
    const result = state.tickets[row.pr];
    if (result?.merge?.status === "merged") {
      openAlerts ??= await listAlerts(token, transport);
      if (openAlerts.some((a) => a.state === "open" && a.dependency?.package?.name === row.name))
        continue;
      const pr = d.prOK(await api.request("GET", `${ROOT}/pulls/${row.pr}`), true, config);
      const { status } = await api.request(
        "GET",
        `${ROOT}/compare/${result.merge.mergeCommit}...${base}`
      );
      if (
        pr.merged !== true ||
        pr.head.sha !== row.head ||
        pr.merge_commit_sha !== result.merge.mergeCommit ||
        !["ahead", "identical"].includes(status) ||
        !(await verifyResolvedLock(api, row, lock, tools))
      )
        throw Error("Dependency resolution lacks verified merge");
      const issue = await api.request("GET", `${ROOT}/issues/${row.issue}`);
      if (issue.state === "open") {
        if (!issueOK(issue, key, row)) throw Error("Dependency alert issue changed");
        await current(api, base);
        const closed = await api.request("PATCH", `${ROOT}/issues/${row.issue}`, {
          state: "closed",
          state_reason: "completed",
        });
        if (
          closed.number !== row.issue ||
          closed.state !== "closed" ||
          closed.state_reason !== "completed"
        )
          throw Error("Dependency alert ticket closure not acknowledged");
      } else if (
        issue.state !== "closed" ||
        issue.state_reason !== "completed" ||
        !issueOK({ ...issue, state: "open" }, key, row)
      )
        throw Error("Dependency alert closure requires reconciliation");
      await advance(store, key, row, { phase: "resolved" });
    } else if (!result?.merge && (await canRefresh(api, state, row))) {
      const pr = d.prOK(await api.request("GET", `${ROOT}/pulls/${row.pr}`), true, config);
      const issue = await api.request("GET", `${ROOT}/issues/${row.issue}`);
      if (pr.state !== "open" || !issueOK(issue, key, row)) continue;
      if (pr.head.sha !== row.head || pr.head.ref !== d.alertBranch(key))
        throw Error("Dependency alert proposal changed externally");
      if (row.base === base && !result)
        return { outcome: "awaiting-dependency-pickup", issue: row.issue, pr: row.pr };
      if (
        row.base !== base &&
        (!result || result.dependency?.attempts.length < Math.min(10, config.reviews))
      ) {
        const recovered = await refresh(key, row);
        if (recovered) return recovered;
      }
    }
  }
  if (active.length || refreshing) return { outcome: "factory-busy" };
  if (require("./dependency-policy.cjs").pending(state))
    return { outcome: "pending-protected-merge" };
  const day = policy.dayKey(now, config.timezone);
  if (
    (state.days[day] || []).length >= config.daily ||
    Object.values(registry.records).filter((row) => row.day === day).length >= 10
  )
    return { outcome: "daily-limit" };
  const { AutomaticCoordinator } = require("./automation.cjs");
  if (await new AutomaticCoordinator(api, config, {}).candidate(state))
    return { outcome: "app-work-first" };
  const open = await api.pages(`${ROOT}/pulls?state=open&base=main`);
  for (const pr of open) {
    try {
      d.prOK(pr);
    } catch {
      continue;
    }
    const previous = state.tickets[pr.number];
    if (pr.base.sha !== base || previous?.dependency?.attempts.some((a) => a.head === pr.head.sha))
      continue;
    const compare = await api.request("GET", `${ROOT}/compare/${base}...${pr.head.sha}`);
    if (compare.behind_by === 0 && compare.merge_base_commit?.sha === base)
      return { outcome: "existing-dependency-pr" };
  }
  const { plans, nextOffset } = await preview(token, lock, tools, transport, {
    offset: registry.cursor,
  });
  for (const plan of plans) {
    const tracked = openRecord(registry, plan.package);
    if (tracked && (tracked[1].phase !== "tracking" || plan.status !== "compatible-candidate"))
      continue;
    const { candidate, reason } = await buildCandidate(plan, lock, manifest, tools, transport);
    if (!candidate) {
      if (tracked || !Object.hasOwn(TRACKING_REASONS, reason)) continue;
      const earlier = Object.values(registry.records).filter(
        (row) => row.name === plan.package && row.trackingReason
      ).length;
      const key = d.digest(["yarn.lock", plan.package, earlier]);
      await current(api, base);
      await ensureLabel(
        api,
        HELD_LABEL,
        "fbca04",
        "Tracked dependency vulnerability awaiting evidence or a wider update"
      );
      const row = await addRecord(store, key, {
        name: plan.package,
        day,
        trackingReason: reason,
        phase: "tracking-intent",
        issue: null,
        pr: null,
      });
      return postTrackingIssue(api, store, base, key, row);
    }
    const key = tracked?.[0] || d.digest([plan.package, plan.candidate, plan.locked]);
    if (tracked) {
      const row = tracked[1];
      const issue = await api.request("GET", `${ROOT}/issues/${row.issue}`);
      if (!trackingIssueOK(issue, key, row)) continue;
    } else if (registry.records[key]) continue;
    await current(api, base);
    const head = await makeCommit(api, base, candidate);
    const preparation = { candidate: plan.candidate, day, base, head };
    const saved = tracked
      ? await advance(store, key, tracked[1], { ...preparation, phase: "issue" })
      : await addRecord(store, key, {
          ...preparation,
          name: plan.package,
          phase: "prepared",
          issue: null,
          pr: null,
        });
    const published = await publish(api, app, config, store, key, saved);
    return { outcome: "published", issue: published.issue, pr: published.pr };
  }
  if (registry.cursor !== nextOffset) {
    await current(api, base);
    await store.update((next) => {
      next.cursor = nextOffset;
      return { state: next };
    });
  }
  return { outcome: "no-compatible-update" };
}

async function main(env = process.env) {
  policy.assertSubscriptionEnv(env);
  if (
    env.GITHUB_REPOSITORY !== policy.REPOSITORY ||
    env.GITHUB_ACTOR !== policy.OWNER ||
    env.GITHUB_TRIGGERING_ACTOR !== policy.OWNER ||
    env.GITHUB_REF !== "refs/heads/main" ||
    !["workflow_dispatch", "schedule"].includes(env.GITHUB_EVENT_NAME) ||
    env.GITHUB_RUN_ATTEMPT !== "1" ||
    !d.SHA.test(env.GITHUB_SHA || "") ||
    env.GITHUB_SHA !== env.GITHUB_WORKFLOW_SHA ||
    env.GITHUB_WORKFLOW_REF !== `${policy.REPOSITORY}/${WORKFLOW_FILE}@refs/heads/main`
  )
    throw Error("Unauthorized dependency alert workflow");
  const result = await runRepair({
    api: new GitHub({ token: env.GH_TOKEN }),
    app: new GitHub({ token: env.DEPENDENCY_PUBLISH_TOKEN }),
    token: env.DEPENDABOT_READ_TOKEN,
    config: policy.readConfig(JSON.parse(env.FACTORY_VARIABLES || "{}")),
    base: env.GITHUB_SHA,
    lock: fs.readFileSync("yarn.lock", "utf8"),
    manifest: fs.readFileSync("package.json", "utf8"),
    tools: toolsAt(path.join(__dirname, "dependency-tools")),
  });
  console.log(JSON.stringify({ ...result, modelCalls: 0 }));
  if (env.GITHUB_STEP_SUMMARY) {
    const repo = `https://github.com/${policy.REPOSITORY}`;
    const links = [
      validId(result.issue) && `[Issue #${result.issue}](${repo}/issues/${result.issue})`,
      validId(result.pr) && `[PR #${result.pr}](${repo}/pull/${result.pr})`,
    ].filter(Boolean);
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      [
        "## Dependabot alert intake",
        "",
        `Outcome ` + result.outcome.replaceAll("-", " "),
        ...(links.length ? ["", links.join(" · ")] : []),
        "",
      ].join("\n")
    );
  }
}

if (require.main === module)
  main().catch(() => {
    console.error("Dependency alert repair held. Inspect the factory receipt before retrying.");
    process.exitCode = 1;
  });

module.exports = {
  READY_LABEL,
  AlertAdmissionHold,
  issueTitle,
  issueBody,
  verifyAlertPR,
  patchLock,
  runRepair,
};
