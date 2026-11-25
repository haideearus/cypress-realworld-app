const policy = require("./policy.cjs");
const dependency = require("./dependency-contract.cjs");
const slots = require("./active-tickets.cjs");
const { Ledger, ROOT } = require("./github.cjs");
const { MetadataStore } = require("./metadata-store.cjs");
const { WakeStore } = require("./wake-store.cjs");

const READY_LABEL = "factory-dependency-ready";
const LIMIT = 500;
const RECOVERY_HEADS_PER_PR = 10;
const RECOVERY_BASES_PER_HEAD = 5;
const REFRESH_COMMAND = "@dependabot rebase";
const STALE_NOTES = {
  manual: {
    status: "Dependabot refresh needs the owner credential",
    detail:
      "The repository secret `FACTORY_DEPENDABOT_REBASE_TOKEN` is unset. A repository writer can comment `@dependabot rebase` on the PR.",
  },
  requested: {
    status: "Dependabot refresh requested",
    detail: "GitHub accepted the Dependabot rebase request. Wait for a new Dependabot commit.",
  },
  unconfirmed: {
    status: "Dependabot refresh delivery unconfirmed",
    detail:
      "The factory could not confirm delivery of its Dependabot rebase request. If no new commit appears, check the PR and request a rebase there.",
  },
};
const EVIDENCE_BLOCKERS = {
  invalid_public_evidence:
    "The public dependency evidence was unavailable or invalid. Check the registry, advisory and CI evidence linked in the run.",
  public_service_unavailable:
    "The public evidence service did not recover within this attempt’s retry window.",
  public_rate_limit:
    "The public evidence service reported a rate limit. Inspect the run for details.",
  candidate_changed:
    "The dependency candidate changed during verification. Wait for a current Dependabot commit and its CI.",
};
const PUBLICATIONS_PER_RUN = 5;
const INSPECTIONS_PER_RUN = 12;
const TRACKING_FALLBACK_INSPECTIONS = 4;
const BUDGET_MS = 60_000;
const ALLOW_MISSING = { allowMissing: true };
const validNumber = (n) => Number.isSafeInteger(n) && n > 0;
const empty = () => ({ version: 1, records: {} });
class TrackingDeadline extends Error {}

function validRefresh(receipt) {
  return (
    (receipt.refresh === undefined || ["attempted", "confirmed"].includes(receipt.refresh)) &&
    (receipt.stale === undefined ||
      (Object.hasOwn(STALE_NOTES, receipt.stale) &&
        (receipt.stale === "manual" ||
          (receipt.stale === "requested" && receipt.refresh === "confirmed") ||
          (receipt.stale === "unconfirmed" && receipt.refresh === "attempted"))))
  );
}

function validBases(bases) {
  return (
    bases &&
    typeof bases === "object" &&
    !Array.isArray(bases) &&
    Object.keys(bases).length <= RECOVERY_BASES_PER_HEAD &&
    Object.entries(bases).every(
      ([base, receipt]) =>
        dependency.SHA.test(base) &&
        receipt &&
        typeof receipt === "object" &&
        !Array.isArray(receipt) &&
        Object.keys(receipt).length > 0 &&
        Object.keys(receipt).every((key) => ["refresh", "stale"].includes(key)) &&
        validRefresh(receipt)
    )
  );
}

function validRecovery(recovery) {
  return (
    recovery &&
    typeof recovery === "object" &&
    !Array.isArray(recovery) &&
    Object.keys(recovery).length <= RECOVERY_HEADS_PER_PR &&
    Object.entries(recovery).every(
      ([head, receipt]) =>
        dependency.SHA.test(head) &&
        receipt &&
        typeof receipt === "object" &&
        !Array.isArray(receipt) &&
        Object.keys(receipt).length > 0 &&
        Object.keys(receipt).every((key) =>
          ["refresh", "stale", "blocked", "bases"].includes(key)
        ) &&
        validRefresh(receipt) &&
        (receipt.blocked === undefined || receipt.blocked === true) &&
        (receipt.bases === undefined || validBases(receipt.bases))
    )
  );
}

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
      Object.keys(row).some(
        (key) => !["branch", "issue", "status", "rejected", "recovery"].includes(key)
      ) ||
      !dependency.branch(row.branch) ||
      !["intent", "open", "closing", "closed", "merged"].includes(row.status) ||
      (row.rejected !== undefined &&
        (row.status !== "intent" || ![403, 422].includes(row.rejected))) ||
      (row.recovery !== undefined && (row.status === "intent" || !validRecovery(row.recovery))) ||
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

function isActionsBot(user) {
  return user?.login === "github-actions[bot]" && user.id === 41898282 && user.type === "Bot";
}

function isOwner(user) {
  return user?.login === "haideearus" && user.id === 101267861 && user.type === "User";
}

function issueOK(issue, pr, number) {
  return (
    validNumber(issue?.number) &&
    issue.number !== pr &&
    (number === null || issue.number === number) &&
    ["open", "closed"].includes(issue.state) &&
    !issue.pull_request &&
    isActionsBot(issue.user) &&
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

function inspectionBatch(rows, now, limit = INSPECTIONS_PER_RUN) {
  if (limit === 0) return [];
  if (rows.length <= limit) return rows;
  const batches = Math.ceil(rows.length / limit);
  const start = (Math.floor(now / 3_600_000) % batches) * limit;
  return rows.slice(start, start + limit);
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

function recoveryAllowed(state, pr) {
  const t = state.tickets[String(pr.number)];
  return (
    !state.stop &&
    !slots.activeFor(state, pr.number) &&
    !slots.pendingIntent(state) &&
    !Object.values(state.grants).some((g) => g.ticket === pr.number && g.status === "reserved") &&
    (!t || (t.origin === "dependency-pr" && t.branch === pr.head.ref && !t.merge))
  );
}

function blocker(state, pr) {
  const t = state.tickets[String(pr.number)];
  if (t?.head !== pr.head.sha || t.status !== "blocked") return null;
  const attempt = dependency.validateTicket(t);
  const evidence = attempt.evidence?.at(-1);
  const hasReview = Object.values(state.grants).some(
    (g) => g.ticket === pr.number && g.head === pr.head.sha
  );
  let reason = "Dependency preparation stopped before a review could be reserved.";
  if (hasReview)
    reason = "The independent review did not produce a usable approval for this commit.";
  if (evidence && ["started", "temporary"].includes(evidence.status))
    reason = "Public evidence preparation was interrupted before it could finish.";
  if (evidence?.status === "held") reason = EVIDENCE_BLOCKERS[evidence.reason] || reason;
  return (
    `Dependency maintenance is blocked for \`${pr.head.sha}\`. ${reason} ` +
    `[Inspect the recorded attempt](https://github.com/${policy.REPOSITORY}/actions/runs/${attempt.runId}). ` +
    "The existing attempt remains in the ledger. A fresh Dependabot commit can be checked under the normal limits."
  );
}

async function saveRecovery(store, pr, row, fields, beforeWrite, base) {
  const head = pr.head.sha;
  const previous = row.recovery?.[head];
  const receipt = base
    ? {
        ...previous,
        bases: { ...previous?.bases, [base]: { ...previous?.bases?.[base], ...fields } },
      }
    : { ...previous, ...fields };
  const recovery = { ...row.recovery, [head]: receipt };
  return advance(store, pr.number, row, { ...row, recovery }, beforeWrite);
}

async function sameHead(api, pr) {
  const fresh = await currentPR(api, pr.number, pr.head.ref);
  return fresh?.head.sha === pr.head.sha && fresh.base.sha === pr.base.sha;
}

async function currentMain(api) {
  const { object } = await api.request("GET", `${ROOT}/git/ref/heads/main`);
  if (!dependency.SHA.test(object?.sha || ""))
    throw Error("Invalid main ref for dependency recovery");
  return object.sha;
}

async function staleHead(api, pr, main) {
  const compare = await api.request("GET", `${ROOT}/compare/${main}...${pr.head.sha}?per_page=1`);
  return (
    Number.isSafeInteger(compare.behind_by) &&
    compare.behind_by > 0 &&
    dependency.SHA.test(compare.merge_base_commit?.sha || "") &&
    compare.merge_base_commit.sha !== main
  );
}

async function postRecoveryComment(api, number, body, isAuthor) {
  try {
    const result = await api.request("POST", `${ROOT}/issues/${number}/comments`, { body });
    return validNumber(result?.id) && isAuthor(result.user) && result.body === body;
  } catch (error) {
    if (error instanceof TrackingDeadline) throw error;
    // Treat an uncertain acknowledgement as unconfirmed.
    return false;
  }
}

async function publishRecoveryNote(api, pr, row, kind, message, beforeWrite, base) {
  const marker = `<!-- factory-dependency-recovery:${pr.number}:${pr.head.sha}:${kind}${base ? `:${base}` : ""} -->`;
  const body = `${message}\n\n${marker}`;
  for (let page = 1; page <= 3; page++) {
    const comments = await api.request(
      "GET",
      `${ROOT}/issues/${row.issue}/comments?per_page=100&page=${page}`
    );
    if (!Array.isArray(comments) || comments.length > 100)
      throw Error("Invalid bounded recovery comment list");
    const tracked = comments.find(
      (c) =>
        validNumber(c?.id) &&
        isActionsBot(c.user) &&
        typeof c.body === "string" &&
        c.body.endsWith(marker)
    );
    if (tracked) return tracked.body === body;
    if (comments.length === 100) continue;
    await beforeWrite();
    const issue = await readExisting(api, `${ROOT}/issues/${row.issue}`);
    if (!issueOK(issue, pr.number, row.issue) || issue.state !== "open") return false;
    return postRecoveryComment(api, row.issue, body, isActionsBot);
  }
  // A partial comment list cannot establish that a previous note was never posted.
  return false;
}

function staleNoteKind(refresh) {
  if (refresh === "confirmed") return "requested";
  if (refresh === "attempted") return "unconfirmed";
  return "manual";
}

async function recoveryBatch(api, eligible, now) {
  if (eligible.length < 2) return eligible;
  const { state } = await new WakeStore(api).read(ALLOW_MISSING);
  const byNumber = new Map(eligible.map((pr) => [pr.number, pr]));
  const queued = new Set();
  for (const receipt of Object.values(state.receipts)) {
    const { signal } = receipt;
    if (
      signal.kind === "dependency-ci" &&
      ["pending", "observed"].includes(receipt.status) &&
      byNumber.get(signal.number)?.head.sha === signal.head
    )
      queued.add(byNumber.get(signal.number));
  }
  const ordinary = eligible.filter((pr) => !queued.has(pr));
  const reserved = Math.min(ordinary.length, TRACKING_FALLBACK_INSPECTIONS);
  const priority = inspectionBatch([...queued], now, INSPECTIONS_PER_RUN - reserved);
  const fallback = inspectionBatch(ordinary, now, INSPECTIONS_PER_RUN - priority.length);
  return [...priority, ...fallback];
}

async function recoverTrackedPR({
  api,
  refreshApi,
  store,
  ledger,
  state,
  proposals,
  now,
  beforeWrite,
}) {
  const eligible = [...proposals.values()].filter((pr) => {
    const row = state.records[pr.number];
    const receipt = row?.recovery?.[pr.head.sha];
    return (
      row?.status === "open" &&
      row.branch === pr.head.ref &&
      (receipt || Object.keys(row.recovery || {}).length < RECOVERY_HEADS_PER_PR)
    );
  });
  if (eligible.length === 0) return null;
  const { state: usage } = await ledger.read();
  let main;
  for (const proposal of await recoveryBatch(api, eligible, now)) {
    if (!recoveryAllowed(usage, proposal)) continue;
    const number = proposal.number;
    let row = state.records[number];
    const receipt = row.recovery?.[proposal.head.sha];
    const message = receipt?.blocked ? null : blocker(usage, proposal);
    main ??= await currentMain(api);
    // Older receipts did not record a base. Retain their one-request-per-head hold.
    const base = !receipt?.refresh && (refreshApi || receipt?.bases) ? main : undefined;
    const refreshReceipt = base ? receipt?.bases?.[base] : receipt;
    let refresh = refreshReceipt?.refresh;
    const canRecord =
      !base || refreshReceipt || Object.keys(receipt?.bases || {}).length < RECOVERY_BASES_PER_HEAD;
    const wantsRefresh = Boolean(canRecord && refreshApi && !refresh);
    const wantsStaleNote = canRecord && refreshReceipt?.stale !== staleNoteKind(refresh);
    let stale = false;
    if (wantsRefresh || wantsStaleNote) {
      if (refresh) {
        stale = true;
      } else {
        stale = await staleHead(api, proposal, main);
      }
    }
    if (!stale && !message) continue;

    const pr = await currentPR(api, number, row.branch);
    if (pr?.head.sha !== proposal.head.sha || pr.base.sha !== proposal.base.sha) continue;
    const files = await api.request("GET", `${ROOT}/pulls/${number}/files?per_page=3`);
    try {
      dependency.filesOK(files);
    } catch {
      continue;
    }
    const issue = await readExisting(api, `${ROOT}/issues/${row.issue}`);
    if (!issueOK(issue, number, row.issue) || issue.state !== "open") continue;

    const guard = async () => {
      const { state: latest } = await ledger.read();
      if (!recoveryAllowed(latest, pr) || !(await sameHead(api, pr)))
        throw Error("Native dependency recovery candidate changed");
    };
    if (stale) {
      if (wantsRefresh) {
        refresh = "attempted";
        if ((await currentMain(api)) !== main) continue;
        row = await saveRecovery(store, pr, row, { refresh }, guard, base);
        await guard();
        if ((await currentMain(api)) !== main) continue;
        if (await postRecoveryComment(refreshApi, number, REFRESH_COMMAND, isOwner)) {
          refresh = "confirmed";
          row = await saveRecovery(store, pr, row, { refresh }, beforeWrite, base);
        }
      }
      const kind = staleNoteKind(refresh);
      const { detail, status } = STALE_NOTES[kind];
      const notified = await publishRecoveryNote(
        api,
        pr,
        row,
        kind,
        `Dependency commit \`${pr.head.sha}\` was behind \`main\`. ${detail} The factory keeps all previous attempts.`,
        beforeWrite,
        base
      );
      if (notified) await saveRecovery(store, pr, row, { stale: kind }, beforeWrite, base);
      return {
        pr: number,
        issue: row.issue,
        status: notified ? status : status + ". Tracking note delivery unconfirmed",
      };
    }
    const sent = await publishRecoveryNote(api, pr, row, "blocked", message, guard);
    if (sent) await saveRecovery(store, pr, row, { blocked: true }, beforeWrite);
    return {
      pr: number,
      issue: row.issue,
      status: sent ? "blocker recorded" : "blocker comment delivery unconfirmed",
    };
  }
  return null;
}

async function track(api, refreshApi, preview, recoveryOnly, now, result, links) {
  const ledger = new Ledger(api);
  const beforeWrite = async () => policy.assertNotStopped((await ledger.read()).state);
  if ((await ledger.read()).state.stop)
    return "Factory stopped; native dependency tracking is paused";
  const store = new MetadataStore(api, "dependency-tracking", empty, validate);
  const { state } = await store.read(ALLOW_MISSING);
  const proposals = await openProposals(api);
  const recordRecovery = async () => {
    const recovery = await recoverTrackedPR({
      api,
      refreshApi,
      store,
      ledger,
      state,
      proposals,
      now,
      beforeWrite,
    });
    if (recovery) links.set(recovery.pr, recovery);
    return recovery;
  };
  if (recoveryOnly) {
    if (preview) return "Post-merge dependency recovery is live only";
    const recovery = await recordRecovery();
    return recovery
      ? `Dependency PR #${recovery.pr}. ${recovery.status}.`
      : "No tracked native dependency needs recovery in this bounded scan.";
  }
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
      state.records[number] = await advance(
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
  await recordRecovery();
  for (const [number, row] of Object.entries(state.records)) {
    const pr = Number(number);
    if (links.size >= 10) break;
    if (row.status === "open" && proposals.has(pr) && !links.has(pr))
      links.set(pr, { pr, issue: row.issue, status: "tracked" });
  }
}

async function trackNativeDependencies(
  api,
  config,
  context,
  preview,
  { refreshApi, recoveryOnly = false } = {}
) {
  policy.authorize(context);
  if (!dependency.contextOK(context) || typeof preview !== "boolean")
    throw Error("Unauthorized native dependency tracking");
  if (!preview && (!config.enabled || !config.automatic))
    return { reason: "Native dependency tracking is disabled" };
  const now = Date.now();
  const bounded = (client) => ({
    request(method, path, data) {
      if (Date.now() >= now + BUDGET_MS) throw new TrackingDeadline();
      return client.request(method, path, data);
    },
  });
  const result = { published: 0, reconciled: 0, closed: 0, reopened: 0, held: 0, rejected: 0 };
  const links = new Map();
  let reason;
  try {
    reason = await track(
      bounded(api),
      refreshApi && bounded(refreshApi),
      preview,
      recoveryOnly,
      now,
      result,
      links
    );
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
