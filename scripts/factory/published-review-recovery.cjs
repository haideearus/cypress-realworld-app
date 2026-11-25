const { setTimeout: delay } = require("node:timers/promises");
const policy = require("./policy.cjs");
const slots = require("./active-tickets.cjs");
const { ROOT } = require("./github.cjs");
const { validPath } = require("./artifacts.cjs");

const MAX_REFRESHES = 2;
const STALE_REASON = "Main advanced; published repair requires fresh CI and review";
const INTERRUPTED_REASON = "Published repair recovery stopped before assessment completed";
const RUN = /^[1-9]\d*$/;
const UUID = /^[a-f0-9-]{36}$/;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const exact = (value, keys) => value && Object.keys(value).sort().join(",") === keys;
const passingCiReceipt = (ci) =>
  exact(ci, "head,passed,requestId,runId") &&
  ci.passed === true &&
  positive(ci.runId) &&
  UUID.test(ci.requestId || "") &&
  policy.SHA.test(ci.head || "");
class RecoveryHold extends Error {}
class RecoveryStaleBase extends Error {}

function blockedReview(grant, parent) {
  return (
    parent &&
    grant.phase === "review" &&
    grant.slot === "cycle1" &&
    grant.status === "finished" &&
    grant.outcome === "blocked" &&
    grant.runId === parent.runId &&
    grant.runAttempt === parent.runAttempt &&
    grant.head === parent.head
  );
}

function validateRecovery(ticket, grants) {
  const r = ticket.publishedRecovery;
  const skipped = ticket.skippedPublishedReview;
  if (r === undefined && skipped === undefined) return;
  const parents = r?.refreshes;
  const interruptedParent = r?.previousParent ?? r?.parent;
  const owner = (p) =>
    exact(p, "head,runAttempt,runId,workflowSha") &&
    RUN.test(p.runId || "") &&
    p.runAttempt === 1 &&
    policy.SHA.test(p.workflowSha || "") &&
    policy.SHA.test(p.head || "") &&
    p.runId !== ticket.automatic?.runId;
  const keys = r?.previousParent
    ? "parent,previousParent,refreshes,sourceCi"
    : r?.parent
      ? "parent,refreshes,sourceCi"
      : "refreshes,sourceCi";
  if (
    !exact(r, keys) ||
    ticket.origin !== "factory" ||
    !ticket.automatic ||
    ticket.branch !== `agent/factory-${grants[0]?.ticket}` ||
    !positive(ticket.pr) ||
    ticket.coding !== 1 ||
    ticket.reviews > (r?.previousParent ? 2 : 1) ||
    ticket.retries !== 0 ||
    ticket.finding ||
    ticket.monitor ||
    ticket.delayedRetry ||
    !passingCiReceipt(r.sourceCi) ||
    (skipped !== undefined &&
      (!exact(skipped, "ci,grant") ||
        !UUID.test(skipped.grant || "") ||
        !passingCiReceipt(skipped.ci) ||
        skipped.ci.head !== interruptedParent?.head ||
        !grants.some((g) => g.id === skipped.grant && blockedReview(g, interruptedParent)))) ||
    !Array.isArray(parents) ||
    parents.length > MAX_REFRESHES ||
    parents.some(
      (entry) =>
        !exact(entry, "base,from") ||
        !policy.SHA.test(entry.base || "") ||
        !policy.SHA.test(entry.from || "")
    ) ||
    new Set(parents.map(({ base, from }) => `${base}:${from}`)).size !== parents.length ||
    (r.parent && !owner(r.parent)) ||
    (r.previousParent &&
      (!owner(r.previousParent) ||
        !r.parent ||
        r.previousParent.runId === r.parent.runId ||
        (r.previousParent.head === r.parent.head &&
          grants.some(
            (g) =>
              g.phase === "review" && g.runId === r.previousParent.runId && g.id !== skipped?.grant
          )))) ||
    grants.some(
      (g) =>
        g.phase === "review" &&
        (g.runAttempt !== 1 ||
          g.slot !== "cycle1" ||
          ![r.parent, r.previousParent].some((p) => p?.runId === g.runId && p.head === g.head))
    )
  )
    throw Error("Invalid published review recovery receipt");
}

function recoveryParent(ticket, context) {
  const parent = ticket?.publishedRecovery?.parent;
  return Boolean(
    parent &&
      parent.runId === context.runId &&
      parent.runAttempt === context.runAttempt &&
      parent.workflowSha === context.workflowSha
  );
}

function eligible(ticket, n, state, config, context) {
  const r = ticket.publishedRecovery;
  const retryParent =
    r?.parent &&
    !r.previousParent &&
    r.parent.runId !== context.runId &&
    ((ticket.feedback === STALE_REASON && r.parent.workflowSha !== context.workflowSha) ||
      ticket.feedback === INTERRUPTED_REASON);
  return (
    ticket.status === "blocked" &&
    ticket.origin === "factory" &&
    ticket.automatic?.appSlug === config.appSlug &&
    ticket.automatic?.runAttempt === 1 &&
    ticket.coding === 1 &&
    ticket.reviews < Math.min(retryParent ? 2 : 1, config.reviews) &&
    (retryParent || ticket.reviews === 0) &&
    ticket.retries === 0 &&
    config.reviews > 0 &&
    (!ticket.feature || ticket.feature.mode === config.featureMode) &&
    (!r?.parent || retryParent) &&
    !ticket.finding &&
    !ticket.monitor &&
    !ticket.delayedRetry &&
    !ticket.merge &&
    !ticket.approval &&
    positive(ticket.pr) &&
    ticket.branch === `agent/factory-${n}` &&
    (ticket.publishedRecovery?.sourceCi ?? ticket.ci)?.passed === true &&
    !slots.activeFor(state, n)
  );
}

async function releaseTerminalRecovery(coordinator, entry, held, commit) {
  const parent = held?.publishedRecovery?.parent;
  if (
    !parent ||
    !["awaiting_review", "reviewing"].includes(held.status) ||
    held.merge ||
    !slots.owns(entry, { ...parent, ticket: entry.ticket })
  )
    return null;
  const { api, ledger } = coordinator;
  const { verifiedRun } = require("./wake-controller.cjs");
  const run = await verifiedRun(api, parent.runId, parent.runAttempt, "factory-automatic.yml", {
    terminal: false,
    success: false,
  });
  if (
    run.status !== "completed" ||
    run.head_sha !== parent.workflowSha ||
    run.head_branch !== "main"
  )
    return null;
  return ledger.update(
    (state) => {
      policy.assertNotStopped(state);
      const t = state.tickets[entry.ticket];
      if (
        JSON.stringify(t) !== JSON.stringify(held) ||
        !slots.owns(slots.activeFor(state, entry.ticket), entry)
      )
        throw new RecoveryHold("Published recovery ownership changed");
      for (const grant of Object.values(state.grants)) {
        if (slots.owns(entry, grant) && grant.status === "reserved") {
          grant.status = "finished";
          grant.outcome = "blocked";
        }
      }
      t.status = "blocked";
      t.feedback = INTERRUPTED_REASON;
      slots.releaseActive(state, entry);
      policy.audit(state, "published_review_terminal_run_released", entry);
      return { state };
    },
    { expectedCommit: commit }
  );
}

function completedCycleJobs(jobs, expected) {
  return Object.entries(expected).every(([name, conclusion]) => {
    const matching = jobs.filter((job) => job.name === `cycle1 / ${name}`);
    return (
      matching.length === 1 &&
      matching[0].status === "completed" &&
      matching[0].conclusion === conclusion
    );
  });
}

async function verifySkippedReview(coordinator, state, n, ticket, parent, run) {
  const reason = "Earlier review cannot be verified as skipped with passing CI";
  const saved = ticket.skippedPublishedReview;
  const ci = saved?.ci ?? ticket.ci;
  const grants = Object.values(state.grants).filter((g) => g.ticket === n && g.phase === "review");
  const grant = grants[0];
  if (
    run.conclusion !== "success" ||
    grants.length !== 1 ||
    !blockedReview(grant, parent) ||
    !UUID.test(grant.id || "") ||
    (saved && saved.grant !== grant.id) ||
    !passingCiReceipt(ci) ||
    ci.head !== parent.head
  )
    throw new RecoveryHold(reason);

  const { api, controller } = coordinator;
  const [jobs, verified] = await Promise.all([
    api.pages(`${ROOT}/actions/runs/${parent.runId}/attempts/${parent.runAttempt}/jobs`, "jobs"),
    controller.validateCI(ci.runId, ci.head, ci).catch((error) => {
      if (error.message === "CI does not cover the expected head or run attempt")
        throw new RecoveryHold(reason);
      throw error;
    }),
  ]);
  if (
    !verified.passed ||
    !completedCycleJobs(jobs, {
      coding: "skipped",
      publish: "skipped",
      ci: "success",
      reserve_review: "success",
      review: "skipped",
      assess: "success",
    })
  )
    throw new RecoveryHold(reason);
  return { grant: grant.id, ci };
}

async function verifyOriginal(coordinator, state, n, ticket, ci) {
  const { api, controller } = coordinator;
  const source = ticket.automatic;
  const grants = Object.values(state.grants).filter((g) => g.ticket === n && g.phase === "code");
  const grant = grants[0];
  if (
    grants.length !== 1 ||
    grant.phase !== "code" ||
    grant.slot !== "cycle1" ||
    grant.runId !== source.runId ||
    grant.runAttempt !== 1 ||
    grant.status !== "finished" ||
    grant.outcome !== "awaiting_review" ||
    grant.head !== source.workflowSha
  )
    throw new RecoveryHold("Original coding evidence is unavailable");

  const { verifiedRun } = require("./wake-controller.cjs");
  const [run, jobs, verified] = await Promise.all([
    verifiedRun(api, source.runId, 1, "factory-automatic.yml", { success: false }),
    api.pages(`${ROOT}/actions/runs/${source.runId}/attempts/1/jobs`, "jobs"),
    controller.validateCI(ci.runId, ci.head, ci),
  ]);
  const expected = {
    "coding / agent": "success",
    publish: "success",
    ci: "success",
    reserve_review: "failure",
    review: "skipped",
  };
  if (
    run.head_branch !== "main" ||
    run.head_sha !== source.workflowSha ||
    run.conclusion !== "failure" ||
    !verified.passed ||
    !completedCycleJobs(jobs, expected)
  )
    throw new RecoveryHold("Original run lacks passing CI and a failed review reservation");
  const parent = ticket.publishedRecovery?.parent;
  if (parent) {
    const previous = await verifiedRun(api, parent.runId, 1, "factory-automatic.yml", {
      success: false,
    });
    if (previous.head_sha !== parent.workflowSha || previous.head_branch !== "main")
      throw new RecoveryHold("Earlier review recovery run identity changed");
    if (ticket.feedback === INTERRUPTED_REASON && ticket.reviews === 1) {
      const skippedReview = await verifySkippedReview(
        coordinator,
        state,
        n,
        ticket,
        parent,
        previous
      );
      return { originalBase: grant.head, skippedReview };
    }
  }
  return { originalBase: grant.head };
}

async function readPR(api, t, config) {
  const pr = await api.request("GET", `${ROOT}/pulls/${t.pr}`);
  if (
    pr.number !== t.pr ||
    pr.state !== "open" ||
    pr.merged !== false ||
    pr.draft !== false ||
    pr.head?.ref !== t.branch ||
    pr.head?.repo?.full_name !== policy.REPOSITORY ||
    pr.base?.repo?.full_name !== policy.REPOSITORY ||
    pr.base?.ref !== "main" ||
    pr.user?.login !== `${config.appSlug}[bot]` ||
    pr.user?.type !== "Bot" ||
    !policy.SHA.test(pr.head?.sha || "")
  )
    throw new RecoveryHold("Published PR identity or state changed");
  return pr;
}

async function verifyIssue(api, n, ticket, config) {
  const issue = await api.request("GET", `${ROOT}/issues/${n}`);
  const ok = ticket.feature
    ? await require("./feature-origin.cjs").verifyFeatureIssue(api, issue, {
        proof: ticket.feature,
        mode: config.featureMode,
      })
    : require("./automation.cjs").eligibleIssue(issue);
  if (
    issue.number !== n ||
    !ok ||
    require("./controller.cjs").criteriaHash(issue) !== ticket.criteriaHash
  )
    throw new RecoveryHold("Original ready issue or criteria changed");
}

async function compare(api, base, head) {
  if (!policy.SHA.test(base || "") || !policy.SHA.test(head || ""))
    throw new RecoveryHold("Invalid recovery comparison");
  const result = await api.request("GET", `${ROOT}/compare/${base}...${head}?per_page=1`);
  if (!Number.isSafeInteger(result.behind_by) || result.behind_by < 0)
    throw new RecoveryHold("GitHub could not verify the branch comparison");
  return result;
}

function patchIdentity(result, base) {
  const files = result.files;
  if (
    result.behind_by !== 0 ||
    result.merge_base_commit?.sha !== base ||
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > 50 ||
    new Set(files.map((file) => file.filename)).size !== files.length ||
    files.some(
      (file) =>
        !validPath(file.filename) ||
        !["added", "modified", "removed"].includes(file.status) ||
        !policy.SHA.test(file.sha || "")
    )
  )
    throw new RecoveryHold("Published patch cannot be verified against main");
  return JSON.stringify(files.map((f) => [f.filename, f.status, f.sha]).sort());
}

async function verifyRefresh(api, from, head, base, patch) {
  const commit = await api.request("GET", `${ROOT}/git/commits/${head}`);
  const parents = commit.parents?.map((p) => p.sha);
  if (
    commit.sha !== head ||
    !Array.isArray(parents) ||
    parents.length !== 2 ||
    parents[0] !== from ||
    parents[1] !== base ||
    patchIdentity(await compare(api, base, head), base) !== patch
  )
    throw new RecoveryHold("Updated branch does not preserve the original patch");
}

async function currentBase(api, base) {
  const main = await api.request("GET", `${ROOT}/git/ref/heads/main`);
  if (main.object?.sha !== base)
    throw new RecoveryStaleBase("Main advanced during published review recovery");
}

async function assertRecoveryBase(api, ticket) {
  const base = ticket.publishedRecovery.parent.workflowSha;
  await currentBase(api, base);
  const result = await compare(api, base, ticket.head);
  if (result.behind_by !== 0 || result.merge_base_commit?.sha !== base)
    throw new RecoveryStaleBase("Published recovery branch is behind main");
}

async function resumeOne(coordinator, state, commit, n, dryRun, sleep, recordWrite) {
  const { api, config, context, ledger } = coordinator;
  let t = state.tickets[n];
  const receipt = t.publishedRecovery ?? { sourceCi: t.ci, refreshes: [] };
  const { originalBase, skippedReview } = await verifyOriginal(
    coordinator,
    state,
    n,
    t,
    receipt.sourceCi
  );
  await verifyIssue(api, n, t, config);
  const { head: base } = await require("./discovery-run.cjs")
    .testedMain(api, context, undefined, { exactHead: true })
    .catch((error) => {
      if (
        [
          "Current main changed; fresh invocation required",
          "Successful current-main push CI required",
          "Current-main verification job required",
        ].includes(error.message)
      )
        throw new RecoveryHold("Waiting for passing CI on current main");
      throw error;
    });
  const patch = patchIdentity(
    await compare(api, originalBase, receipt.sourceCi.head),
    originalBase
  );
  let pr = await readPR(api, t, config);

  const save = async (mutate) => {
    const previous = t;
    const saved = await ledger.update(
      (current) => {
        policy.assertNotStopped(current);
        if (
          JSON.stringify(current.tickets[n]) !== JSON.stringify(previous) ||
          !eligible(current.tickets[n], n, current, config, context) ||
          !slots.capacity(current, config.concurrent) ||
          slots.pendingIntent(current)
        )
          throw new RecoveryHold("Published recovery state changed");
        const next = current.tickets[n];
        next.publishedRecovery ??= structuredClone(receipt);
        if (skippedReview) next.skippedPublishedReview ??= structuredClone(skippedReview);
        mutate(next, current);
        return { state: current };
      },
      { expectedCommit: commit }
    );
    state = saved.state;
    commit = saved.commit;
    t = state.tickets[n];
    recordWrite();
  };

  if (pr.head.sha !== t.head) {
    const request = receipt.refreshes.at(-1);
    if (request?.from !== t.head) throw new RecoveryHold("Unrecognized published branch update");
    await verifyRefresh(api, t.head, pr.head.sha, request.base, patch);
    if (!dryRun)
      await save((next) => {
        next.head = pr.head.sha;
        next.ci = null;
      });
  }

  let result = await compare(api, base, pr.head.sha);
  if (result.behind_by > 0) {
    if (dryRun)
      return {
        ready: false,
        preview: true,
        ticket: n,
        reason: "Published branch needs a verified refresh",
      };
    if (receipt.refreshes.some((r) => r.from === pr.head.sha && r.base === base))
      throw new RecoveryHold("Waiting for the recorded branch refresh");
    if (receipt.refreshes.length >= MAX_REFRESHES)
      throw new RecoveryHold("Published branch refresh limit reached");
    const from = pr.head.sha;
    await currentBase(api, base);
    await save((next, current) => {
      next.publishedRecovery.refreshes.push({ from, base });
      policy.audit(current, "published_review_refresh_requested", {
        ticket: n,
        pr: t.pr,
        from,
        base,
      });
    });
    await currentBase(api, base);
    policy.assertNotStopped((await ledger.read()).state);
    try {
      // GitHub updates only the existing PR branch and checks its current head.
      await api.request("PUT", `${ROOT}/pulls/${t.pr}/update-branch`, { expected_head_sha: from });
    } catch (error) {
      if ([403, 409, 422].includes(error.status))
        throw new RecoveryHold("GitHub refused the expected-head branch refresh");
      // Observe the durable intent on the next run if delivery was uncertain.
      throw new RecoveryHold("Branch refresh delivery is unconfirmed");
    }
    for (let i = 0; i < 4; i++) {
      pr = await readPR(api, t, config);
      if (pr.head.sha !== from) break;
      if (i < 3) await sleep(2000);
    }
    if (pr.head.sha === from)
      throw new RecoveryHold("Waiting for GitHub to update the published branch");
    await verifyRefresh(api, from, pr.head.sha, base, patch);
    result = await compare(api, base, pr.head.sha);
  }

  if (patchIdentity(result, base) !== patch)
    throw new RecoveryHold("Current PR does not match the original verified patch");
  if (dryRun)
    return {
      ready: false,
      preview: true,
      ticket: n,
      reason: "Published repair can continue at CI and review",
    };

  await currentBase(api, base);
  await verifyIssue(api, n, t, config);
  if ((await readPR(api, t, config)).head.sha !== pr.head.sha)
    throw new RecoveryHold("Published PR changed before claiming recovery");
  const parent = {
    runId: context.runId,
    runAttempt: context.runAttempt,
    workflowSha: base,
    head: pr.head.sha,
  };
  if (receipt.parent?.head === parent.head && t.reviews > 0 && !skippedReview)
    throw new RecoveryHold("Review recovery needs a fresh head");
  await save((next, current) => {
    slots.claimActive(
      current,
      { ticket: n, runId: parent.runId, runAttempt: parent.runAttempt },
      config.concurrent
    );
    if (next.head !== pr.head.sha) next.ci = null;
    next.head = pr.head.sha;
    next.status = "awaiting_review";
    if (next.publishedRecovery.parent)
      next.publishedRecovery.previousParent = next.publishedRecovery.parent;
    next.publishedRecovery.parent = parent;
    policy.audit(current, "published_review_resumed", {
      ticket: n,
      pr: t.pr,
      head: next.head,
      runId: parent.runId,
    });
  });
  return {
    ready: true,
    reviewOnly: true,
    ticket: n,
    head: t.head,
    reason: "Continuing the published repair at CI and independent review",
  };
}

async function resumePublishedReview(coordinator, state, commit, dryRun, sleep = delay) {
  const { config, context } = coordinator;
  if (
    !config.enabled ||
    !config.automatic ||
    state.stop ||
    context.runAttempt !== 1 ||
    !RUN.test(context.runId || "") ||
    !policy.isAutomaticContext(context) ||
    (context.wake && !config.eventPickup) ||
    !slots.capacity(state, config.concurrent) ||
    slots.pendingIntent(state)
  )
    return null;
  const candidates = Object.entries(state.tickets).filter(
    ([n, t]) =>
      eligible(t, Number(n), state, config, context) &&
      (!context.wake || require("./trusted-wake.cjs").allowedModelBots(context, t))
  );
  const offset =
    candidates.length > 4 ? Number(BigInt(context.runId) % BigInt(candidates.length)) : 0;
  let hold = null;
  let wrote = false;
  for (let i = 0; i < Math.min(4, candidates.length); i++) {
    const [number] = candidates[(offset + i) % candidates.length];
    const n = Number(number);
    try {
      return await resumeOne(coordinator, state, commit, n, dryRun, sleep, () => {
        wrote = true;
      });
    } catch (error) {
      if (
        !(error instanceof RecoveryHold || error instanceof RecoveryStaleBase) &&
        ![404, 500, 502, 503, 504].includes(error.status)
      )
        throw error;
      hold = { ready: false, reason: `Issue #${n}. ${error.message}.` };
      // A branch-refresh intent may already be in the ledger. Re-read it on
      // the next pickup instead of making another write from this snapshot.
      if (wrote) return hold;
    }
  }
  return hold;
}

module.exports = {
  resumePublishedReview,
  validateRecovery,
  recoveryParent,
  assertRecoveryBase,
  releaseTerminalRecovery,
  RecoveryStaleBase,
  STALE_REASON,
  INTERRUPTED_REASON,
};
