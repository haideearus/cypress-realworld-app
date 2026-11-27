const { randomUUID } = require("node:crypto");
const { ROOT } = require("./github.cjs");
const { MetadataStore } = require("./metadata-store.cjs");
const {
  SHA,
  ID,
  HASH,
  exact,
  digest,
  BOT,
  BOT_ID,
  OWNER,
  REPOSITORY,
} = require("./wake-contract.cjs");
const retry = require("./dependency-merge-retry.cjs");
const dependency = require("./dependency-contract.cjs");
const alerts = require("./dependency-alert-repair.cjs");
const { validateHarnessFaults } = require("./activity-contract.cjs");
const { recordHarnessFaults } = require("./activity-harness-faults.cjs");

const WINDOW_MS = 24 * 60 * 60 * 1000;
const VERIFIER_FAULT = "review-gate-verifier";
const REFRESH_FAILED = "Refreshed native review gate did not pass";
const CLAIM = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const validNumber = (n) => Number.isSafeInteger(n) && n > 0;
const isBot = (u) => u?.login === BOT && u.id === BOT_ID && u.type === "Bot";
const marker = (n) => `<!-- factory-dependency-merge-hold:${n} -->`;
const emptyReports = () => ({ version: 1, repository: REPOSITORY, notes: {}, harnessFaults: {} });

function validateReports(state) {
  if (
    !exact(state, "version,repository,notes,harnessFaults") ||
    state.repository !== REPOSITORY ||
    state.version !== 1 ||
    !state.notes ||
    typeof state.notes !== "object" ||
    Array.isArray(state.notes) ||
    Object.keys(state.notes).length > 1600
  )
    throw Error("Invalid dependency merge reports");
  validateHarnessFaults(state.harnessFaults);
  if (Object.keys(state.harnessFaults).some((k) => k !== VERIFIER_FAULT))
    throw Error("Unknown merge report fault");
  for (const [number, note] of Object.entries(state.notes)) {
    if (
      !ID.test(number) ||
      !exact(note, "issue,runId,commentId,claim,bodyHash") ||
      !HASH.test(note.bodyHash || "") ||
      !validNumber(note.issue) ||
      !validNumber(note.runId) ||
      (note.commentId !== null && !validNumber(note.commentId)) ||
      (note.claim === null ? !validNumber(note.commentId) : !CLAIM.test(note.claim || ""))
    )
      throw Error("Invalid dependency merge comment receipt");
  }
  return state;
}

const reportsFor = (api) => new MetadataStore(api, "merge-reports", emptyReports, validateReports);
const belongsToRun = (record, run) => (record.run?.runId ?? record.sourceRun) === String(run.id);

function matchingHold(state, run) {
  if (state.stop) return null;
  const matches = Object.values(state.tickets).filter((ticket) => {
    const row = retry.current(ticket);
    if (
      ticket.origin !== "dependency-pr" ||
      ticket.merge ||
      row?.phase !== "held" ||
      !belongsToRun(row, run)
    )
      return false;
    const grant = state.grants[row.grant];
    const parent = row.run ?? ticket.dependency?.attempts?.at(-1);
    return (
      parent?.runId === String(run.id) &&
      parent.runAttempt === run.run_attempt &&
      parent.workflowSha === run.head_sha &&
      grant?.ticket === ticket.pr &&
      grant.head === ticket.head &&
      grant.phase === "review" &&
      grant.status === "finished" &&
      grant.outcome === "reviewed" &&
      ticket.approval.verdict === "pass" &&
      ticket.approval.source === "claude-subscription" &&
      ticket.approval.fixture === false
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

async function linkedIssue(api, ticket, alertStore) {
  const pr = await api.request("GET", `${ROOT}/pulls/${ticket.pr}`);
  if (
    pr?.number !== ticket.pr ||
    pr.head?.sha !== ticket.head ||
    pr.head.ref !== ticket.branch ||
    pr.state !== "open" ||
    pr.merged !== false
  )
    return null;
  const key = dependency.alertKey(ticket.branch);
  if (!key) return require("./dependency-tracking.cjs").verifiedTrackingIssue(api, pr);
  dependency.prOK(pr, false, { alertRepair: true, appSlug: ticket.dependency.appSlug });
  const row = (await alertStore.read()).state.records[key];
  if (
    row?.phase !== "ready" ||
    row.pr !== ticket.pr ||
    row.head !== ticket.head ||
    !validNumber(row.issue)
  )
    return null;
  const issue = await api.request("GET", `${ROOT}/issues/${row.issue}`);
  return alerts.issueOK(issue, key, row) ? issue.number : null;
}

function verifierUnavailable(state, ticket, run) {
  return (
    ticket.dependencyMergeRetry.failure.reason === REFRESH_FAILED &&
    state.audit?.some(
      (event) =>
        ["dependency_merge_preflight_held", "automatic_merge_not_sent"].includes(event.event) &&
        event.ticket === ticket.pr &&
        event.head === ticket.head &&
        event.runId === String(run.id) &&
        event.recovery === "held" &&
        event.trustedGateRefreshUnavailable === true
    )
  );
}

function reportBody(ticket, run, verifierHeld) {
  const row = ticket.dependencyMergeRetry;
  const gate = row.failure.stage === "required-checks";
  const reason = verifierHeld
    ? "A fresh required review gate could not be verified."
    : gate
      ? "The required GitHub checks did not authorize the merge."
      : "The final verification did not authorize the merge.";
  return [
    marker(ticket.pr),
    `**Factory merge held for PR #${ticket.pr}**`,
    `Reviewed commit \`${ticket.head}\`. ${reason}`,
    "The saved independent review and attempt history are retained. No timed retry is queued for this hold.",
    gate
      ? "Next action: verify the required check on this exact commit."
      : "Next action: inspect the final verification in the linked run.",
    `[Dependency maintenance run ${run.id}](https://github.com/${REPOSITORY}/actions/runs/${run.id})`,
  ].join("\n\n");
}

async function findComment(api, issue, pr) {
  let match;
  for (let page = 1; page <= 5; page++) {
    const rows = await api.request(
      "GET",
      `${ROOT}/issues/${issue}/comments?per_page=100&page=${page}`
    );
    if (!Array.isArray(rows) || rows.length > 100) throw Error("Invalid merge note lookup");
    for (const row of rows) {
      if (!isBot(row?.user) || !row.body?.startsWith(marker(pr) + "\n\n")) continue;
      if (
        match ||
        !validNumber(row.id) ||
        row.issue_url !== `https://api.github.com${ROOT}/issues/${issue}`
      )
        throw Error("Ambiguous merge note");
      match = row;
    }
    if (rows.length < 100) return match;
  }
  throw Error("Incomplete merge note lookup");
}

async function publishReport(api, store, ledger, ticket, run, issue, verifierHeld) {
  const number = ticket.pr;
  const body = reportBody(ticket, run, verifierHeld);
  const bodyHash = digest(body);
  const token = randomUUID();
  const existing = await findComment(api, issue, number);
  const current = matchingHold((await ledger.read()).state, run);
  if (
    current?.pr !== ticket.pr ||
    current.head !== ticket.head ||
    current.approval.grant !== ticket.approval.grant
  )
    return "held";
  let decision;
  try {
    decision = await store.update(
      (state) => {
        let prior = state.notes[number];
        if (prior?.issue !== undefined && prior.issue !== issue) return { state, unchanged: true };
        let reconciled = false;
        if (prior?.claim) {
          if (
            !existing ||
            digest(existing.body) !== prior.bodyHash ||
            (prior.commentId !== null && prior.commentId !== existing.id)
          )
            return { state, unchanged: true };
          prior = { ...prior, claim: null, commentId: existing.id };
          state.notes[number] = prior;
          reconciled = true;
        }
        if (prior?.runId >= run.id) return { state, unchanged: !reconciled, recorded: true };
        if (prior && existing?.id !== prior.commentId) return { state, unchanged: true };
        const commentId = existing?.id ?? null;
        state.notes[number] = { issue, runId: run.id, commentId, claim: token, bodyHash };
        return { state, send: true };
      },
      { allowMissing: true }
    );
  } catch (error) {
    // A lost repository response can still have saved this observer's claim.
    const { state } = await store.read({ allowMissing: true });
    if (state.notes[number]?.claim !== token) throw error;
    decision = { state, send: true };
  }
  if (!decision.send) return decision.recorded ? "recorded" : "held";

  const row = decision.state.notes[number];
  const comment =
    existing?.body === body
      ? existing
      : await api.request(
          row.commentId ? "PATCH" : "POST",
          row.commentId
            ? `${ROOT}/issues/comments/${row.commentId}`
            : `${ROOT}/issues/${issue}/comments`,
          { body }
        );
  if (
    !validNumber(comment?.id) ||
    (row.commentId && row.commentId !== comment.id) ||
    !isBot(comment.user) ||
    comment.body !== body ||
    comment.issue_url !== `https://api.github.com${ROOT}/issues/${issue}`
  )
    return "held";
  await store.update((state) => {
    const current = state.notes[number];
    if (current?.claim !== token) return { state, unchanged: true };
    state.notes[number] = { ...current, claim: null, commentId: comment.id };
    return { state };
  });
  return "recorded";
}

// Called after the activity observer verifies the workflow and its trusted producer.
async function reportDependencyMergeHold({
  api,
  ledger,
  run,
  state,
  reportStore = reportsFor(api),
  alertStore = alerts.storeFor(api),
}) {
  const now = Date.now();
  const at = Date.parse(run.updated_at);
  const created = Date.parse(run.created_at);
  if (
    run.path !== ".github/workflows/factory-dependencies.yml" ||
    run.head_branch !== "main" ||
    run.repository?.full_name !== REPOSITORY ||
    run.head_repository?.full_name !== REPOSITORY ||
    !validNumber(run.id) ||
    !SHA.test(run.head_sha || "") ||
    run.run_attempt !== 1 ||
    run.status !== "completed" ||
    !["workflow_dispatch", "schedule"].includes(run.event) ||
    run.actor?.id !== run.triggering_actor?.id ||
    run.actor?.login !== run.triggering_actor?.login ||
    !(isBot(run.actor) || (run.actor?.login === OWNER && run.actor.id === 101267861)) ||
    !(created >= now - WINDOW_MS && created <= at && at <= now)
  )
    return;
  state ??= (await ledger.read()).state;
  const ticket = matchingHold(state, run);
  if (!ticket) return;

  let shared;
  const verifierHeld = verifierUnavailable(state, ticket, run);
  if (verifierHeld) {
    shared = await recordHarnessFaults({
      api,
      store: reportStore,
      ledger,
      run,
      keys: [VERIFIER_FAULT],
      now,
      at,
      allowMissing: true,
    }).catch(() => "held");
  }
  try {
    const issue = await linkedIssue(api, ticket, alertStore);
    if (
      issue !== null &&
      (await publishReport(api, reportStore, ledger, ticket, run, issue, verifierHeld)) === "held"
    )
      return "held";
  } catch {
    return "held";
  }
  return shared === "held" ? "held" : "recorded";
}

module.exports = { reportDependencyMergeHold, validateReports };
