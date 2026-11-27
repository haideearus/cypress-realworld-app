const slots = require("./active-tickets.cjs");
const { terminalParent } = require("./active-runs.cjs");
const policy = require("./policy.cjs");
const { Controller, criteriaHash } = require("./controller.cjs");
const { Ledger, ROOT } = require("./github.cjs");
const { validPath } = require("./artifacts.cjs");
const { verifyMonitorIssue } = require("./monitor-origin.cjs");
const { ConfirmationUnavailable, readMergePR, mergeReceipt } = require("./merge-confirmation.cjs");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PENDING_CHECK_STATUSES = new Set([
  "queued",
  "requested",
  "waiting",
  "pending",
  "in_progress",
]);
const fingerprint = (ticket) => {
  const { merge, ...rest } = ticket;
  return JSON.stringify(rest);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
class IntentHeld extends Error {}

class AutomaticMerger {
  constructor(api, config, context, { sleep = delay, maxPolls = 30 } = {}) {
    if (!Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 180)
      throw new Error("Invalid merge polling limit");
    this.api = api;
    this.config = config;
    this.context = context;
    this.ledger = new Ledger(api);
    this.controller = new Controller(api, config, context);
    this.sleep = sleep;
    this.maxPolls = maxPolls;
  }
  authorize() {
    if (
      !policy.isAutomaticContext(this.context) ||
      !/^[1-9]\d*$/.test(this.context.runId || "") ||
      !Number.isSafeInteger(this.context.runAttempt) ||
      this.context.runAttempt < 1
    )
      throw new Error("Unauthorized automatic merge context");
  }
  enabled() {
    return this.config.enabled && this.config.automatic && this.config.autoMerge;
  }
  branchFor(ticket) {
    return `agent/factory-${ticket}`;
  }
  mergeLock(state, ticket, merge) {
    return (
      merge?.status === "intent" &&
      slots.owns(slots.activeFor(state, ticket), { ticket, ...merge }) &&
      !Object.values(state.grants).some(
        (grant) => grant.ticket === ticket && grant.status === "reserved"
      )
    );
  }
  automaticTicket(state, ticket) {
    const t = state.tickets[String(ticket)];
    if (t?.findingApiRecovery) throw new Error("Final finding recovery requires a manual merge");
    if (
      !t ||
      t.origin !== "factory" ||
      !t.automatic ||
      !this.config.appSlug ||
      t.automatic.appSlug !== this.config.appSlug ||
      t.automatic.workflowRef !== policy.AUTOMATIC_WORKFLOW_REF ||
      !policy.SHA.test(t.automatic.workflowSha || "") ||
      !/^[a-f0-9]{64}$/.test(t.criteriaHash || "") ||
      (t.pr !== null && t.pr !== undefined && (!Number.isSafeInteger(t.pr) || t.pr < 1)) ||
      (t.branch !== undefined && t.branch !== `agent/factory-${ticket}`)
    )
      throw new Error("Ticket lacks matching automatic factory provenance");
    return t;
  }
  stateTicket(state, ticket, expected) {
    policy.assertNotStopped(state);
    this.authorize();
    const t = this.automaticTicket(state, ticket);
    if (
      (state.version === 1
        ? slots.activeEntries(state).length > 0
        : slots.activeFor(state, ticket) && t.merge?.status === "intent") &&
      !this.mergeLock(state, ticket, t.merge)
    )
      throw new Error("An active ticket holds the factory lock");
    if (
      Object.entries(state.tickets).some(
        ([id, other]) => Number(id) !== ticket && other.merge?.status === "intent"
      )
    )
      throw new Error("Another merge intent holds the global merge writer");
    if (!Number.isSafeInteger(t.pr) || t.pr < 1)
      throw new Error("Ticket lacks matching automatic factory provenance");
    const review = policy.reviewGate(state, { number: t.pr, head: t.head });
    if (!review.ok) throw new Error(review.reason);
    if (expected && fingerprint(t) !== fingerprint(expected))
      throw new Error("Automatic ticket identity, CI, or approval changed");
    return t;
  }
  async current(ticket, expected) {
    const { state } = await this.ledger.read();
    return this.stateTicket(state, ticket, expected);
  }
  async issue(ticket, t, { merged = false, confirmation = false } = {}) {
    const issue = await this.api.request("GET", `${ROOT}/issues/${ticket}`);
    const monitor = t.monitor
      ? await verifyMonitorIssue(this.api, issue, { proof: t.monitor, requireActive: false })
      : null;
    const finding =
      t.finding &&
      (await require("./discovery-origin.cjs").verifyRepairOrigin(this.api, issue, t.finding));
    if (t.feature && !confirmation && t.feature.mode !== this.config.featureMode)
      throw Error("Weekly feature mode changed before a new merge");
    const feature =
      t.feature &&
      (await require("./feature-origin.cjs").verifyFeatureIssue(this.api, issue, {
        proof: t.feature,
        allowClosed: merged,
        ...(confirmation ? {} : { mode: this.config.featureMode }),
      }));
    if (
      issue.number !== ticket ||
      issue.pull_request ||
      (t.monitor
        ? !monitor
        : t.finding
          ? !finding
          : t.feature
            ? !feature
            : issue.user?.login !== policy.OWNER) ||
      (issue.state !== "open" && !(merged && issue.state === "closed")) ||
      criteriaHash(issue) !== t.criteriaHash
    )
      throw new Error("Current issue criteria, owner, or state changed");
  }
  async pr(ticket, t, { confirmation = false } = {}) {
    const pr = await readMergePR(this.api, t.pr, confirmation);
    if (
      pr.number !== t.pr ||
      !["open", "closed"].includes(pr.state) ||
      pr.head?.sha !== t.head ||
      pr.head?.ref !== `agent/factory-${ticket}` ||
      pr.head?.repo?.full_name !== policy.REPOSITORY ||
      pr.base?.repo?.full_name !== policy.REPOSITORY ||
      pr.base?.ref !== "main" ||
      pr.user?.login !== `${this.config.appSlug}[bot]` ||
      pr.draft !== false
    )
      throw new Error("Automatic PR identity or head changed");
    if (pr.state === "open" && !confirmation) {
      const files = await this.api.pages(`${ROOT}/pulls/${t.pr}/files`);
      if (
        files.length < 1 ||
        files.length > 50 ||
        files.some(
          (file) =>
            !validPath(file.filename) ||
            (file.previous_filename !== undefined && !validPath(file.previous_filename))
        )
      )
        throw new Error("Automatic merge only permits factory application changes");
    }
    return pr;
  }
  associated(rows, ticket) {
    return (
      Array.isArray(rows) &&
      rows.some(
        (pr) =>
          pr.number === ticket.pr &&
          pr.head?.sha === ticket.head &&
          pr.head?.ref === this.branchFor(ticket.number, ticket) &&
          pr.url === `https://api.github.com${ROOT}/pulls/${ticket.pr}` &&
          pr.head?.repo?.url === `https://api.github.com${ROOT}` &&
          pr.base?.ref === "main" &&
          pr.base?.repo?.url === `https://api.github.com${ROOT}`
      )
    );
  }
  async nativeCheck(checks, name, file, ticket, t, refresh) {
    // Check names alone do not establish an issuer, workflow, or PR identity.
    const candidates = checks.filter((check) => check.name === name);
    if (
      candidates.length === 0 ||
      candidates.some((check) => !Number.isSafeInteger(check.id) || check.id < 1)
    )
      throw new Error(`Missing native required check: ${name}`);
    const association = { ...t, number: ticket };
    for (const check of candidates.sort((a, b) => b.id - a.id)) {
      if (
        check.app?.id !== 15368 ||
        check.head_sha !== t.head ||
        !Number.isSafeInteger(check.check_suite?.id)
      )
        throw new Error(`Untrusted or stale native required check: ${name}`);
      const prefix = `https://github.com/${policy.REPOSITORY}/actions/runs/`;
      const match =
        typeof check.details_url === "string" &&
        check.details_url.startsWith(prefix) &&
        /^([1-9]\d*)\/job\/([1-9]\d*)$/.exec(check.details_url.slice(prefix.length));
      if (
        !match ||
        !Number.isSafeInteger(Number(match[1])) ||
        !Number.isSafeInteger(Number(match[2]))
      )
        throw new Error(`Native check has no trusted Actions job: ${name}`);
      const runId = Number(match[1]);
      const run = await this.api.request("GET", `${ROOT}/actions/runs/${runId}`);
      // The durable dispatched CI creates another "verify" check on this head.
      // Its exact reservation is checked separately; it cannot replace native PR CI.
      if (
        name === "verify" &&
        runId === t.ci.runId &&
        run.id === runId &&
        run.event === "workflow_dispatch" &&
        run.path === ".github/workflows/factory-ci.yml" &&
        run.check_suite_id === check.check_suite.id
      )
        continue;
      if (
        run.id !== runId ||
        run.path !== `.github/workflows/${file}` ||
        run.event !== "pull_request" ||
        run.head_sha !== t.head ||
        run.head_branch !== this.branchFor(ticket, t) ||
        run.repository?.full_name !== policy.REPOSITORY ||
        run.head_repository?.full_name !== policy.REPOSITORY ||
        run.check_suite_id !== check.check_suite.id ||
        !this.associated(check.pull_requests, association) ||
        !this.associated(run.pull_requests, association)
      )
        throw new Error(`Native check does not belong to its trusted PR workflow: ${name}`);
      const pendingRefresh = { passed: false, failed: false, pending: true, runId };
      if (refresh) {
        if (
          runId !== refresh.runId ||
          !Number.isSafeInteger(run.run_attempt) ||
          run.run_attempt < 1 ||
          run.run_attempt > refresh.runAttempt
        )
          throw new Error("Native review gate run or attempt changed during refresh");
        if (run.run_attempt < refresh.runAttempt) return pendingRefresh;
      }
      const jobsPath = refresh
        ? `${ROOT}/actions/runs/${runId}/attempts/${refresh.runAttempt}/jobs`
        : `${ROOT}/actions/runs/${runId}/jobs?filter=latest`;
      const jobs = await this.api.pages(jobsPath, "jobs").catch((error) => {
        if (refresh && error.status === 404) return [];
        throw error;
      });
      const advertised = jobs.filter((job) => job.id === Number(match[2]));
      // During a requested rerun the commit check and the attempt's job list
      // can arrive in either order. Never accept the earlier attempt's check.
      if (refresh && advertised.length === 0) return pendingRefresh;
      const matching = advertised.filter(
        (job) =>
          job.run_id === runId &&
          job.name === name &&
          (!refresh ||
            (job.head_sha === t.head &&
              (job.run_attempt === undefined || job.run_attempt === refresh.runAttempt))) &&
          job.check_run_url === `https://api.github.com${ROOT}/check-runs/${check.id}`
      );
      if (advertised.length !== 1 || matching.length !== 1)
        throw new Error(`Native check does not identify its current workflow job: ${name}`);
      const job = matching[0];
      const passed =
        check.status === "completed" &&
        check.conclusion === "success" &&
        job.status === "completed" &&
        job.conclusion === "success" &&
        run.status === "completed" &&
        run.conclusion === "success";
      const failed =
        check.status === "completed" &&
        check.conclusion === "failure" &&
        job.status === "completed" &&
        job.conclusion === "failure" &&
        run.status === "completed" &&
        run.conclusion === "failure";
      const pending =
        !passed &&
        [check, job, run].every((item) =>
          item.status === "completed"
            ? item.conclusion === "success"
            : PENDING_CHECK_STATUSES.has(item.status)
        );
      return { passed, failed, pending, runId, runAttempt: run.run_attempt };
    }
    throw new Error(`Missing native required check: ${name}`);
  }
  async checks(ticket, t, { waitForVerify = false, refresh } = {}) {
    let refreshedPR;
    for (let waits = 0; ; waits++) {
      if (waits > 0) {
        const current = await this.current(ticket, t);
        refreshedPR = await this.pr(ticket, current);
        if (refreshedPR.state !== "open")
          throw new Error("PR closed while waiting for native required verify");
      }
      const checks = await this.api.pages(
        `${ROOT}/commits/${t.head}/check-runs?filter=all`,
        "check_runs"
      );
      const verify = await this.nativeCheck(checks, "verify", "factory-ci.yml", ticket, t);
      let waitingFor = "native required verify";
      if (verify.passed) {
        const gate = await this.nativeCheck(
          checks,
          "Factory review gate",
          "factory-review-status.yml",
          ticket,
          t,
          refresh
        );
        if (!refreshedPR || !gate.passed) return gate;
        if (refreshedPR.mergeable === true && refreshedPR.mergeable_state === "clean")
          return { ...gate, refreshedPR };
        if (
          refreshedPR.mergeable === false ||
          (refreshedPR.mergeable !== null && refreshedPR.mergeable_state !== "blocked")
        )
          throw new Error("PR mergeability is not clean");
        waitingFor = "PR mergeability after native required verify";
      } else if (!verify.pending || !waitForVerify) {
        throw new Error("Native required verify check is not successful");
      }
      if (waits === this.maxPolls) throw new Error(`Timed out waiting for ${waitingFor}`);
      if (waits === 0) console.log("Waiting for native required verify on the reviewed PR head");
      await this.sleep(10000);
    }
  }
  async waitForRefreshedGate(ticket, expected, refresh, waitFirst = false) {
    let waitingFor = "the native review gate refresh";
    for (let wait = waitFirst; ; wait = true) {
      if (wait) {
        if (refresh.remainingPolls === 0) break;
        refresh.remainingPolls--;
        await this.sleep(5000);
      }
      const t = await this.current(ticket, expected);
      const gate = await this.checks(ticket, t, { refresh });
      if (gate.passed) {
        const pr = await this.pr(ticket, t);
        if (
          pr.state !== "open" ||
          pr.mergeable === false ||
          (pr.mergeable !== null && !["blocked", "clean"].includes(pr.mergeable_state))
        )
          throw new Error("PR mergeability is not clean");
        if (pr.mergeable === true && pr.mergeable_state === "clean") return;
        waitingFor = "clean PR mergeability after the native review gate refresh";
      } else {
        if (gate.failed || !gate.pending)
          throw new Error("Refreshed native review gate did not pass");
        waitingFor = "the native review gate refresh";
      }
    }
    throw new Error(`Timed out waiting for ${waitingFor}`);
  }
  async ci(t) {
    const ci = await this.controller.validateCI(t.ci?.runId, t.head, t.ci);
    if (!ci.passed) throw new Error("Correlated exact-head factory CI failed");
  }
  record(status, t, mergeCommit) {
    return {
      status,
      head: t.head,
      pr: t.pr,
      at: new Date().toISOString(),
      runId: this.context.runId,
      runAttempt: this.context.runAttempt,
      ...(mergeCommit ? { mergeCommit } : {}),
    };
  }
  async persist(ticket, expected, record, previous) {
    if (!this.enabled()) throw new Error("Automatic merge disabled");
    return this.ledger.update(async (state) => {
      const t = this.stateTicket(state, ticket, expected);
      if (!same(t.merge, previous)) throw new IntentHeld("Merge intent changed concurrently");
      // Recheck within the CAS mutation: a receipt can arrive while a different
      // observer is waiting for GitHub's PR metadata.
      this.checkReceipt(state, ticket, t, record);
      const entry = slots.activeFor(state, ticket);
      if (record.status === "intent") {
        this.authorizeNewIntent(t);
        const nextOwner = { ticket, runId: record.runId, runAttempt: record.runAttempt };
        if (entry && !slots.owns(entry, nextOwner)) {
          const parent = await this.api.request(
            "GET",
            `${ROOT}/actions/runs/${entry.runId}/attempts/${entry.runAttempt}`
          );
          if (parent.status !== "completed" || parent.run_attempt !== entry.runAttempt)
            throw new IntentHeld("Existing ticket parent is not confirmed terminal");
          slots.releaseActive(state, entry);
        }
        slots.claimActive(state, nextOwner, this.config.concurrent);
      } else if (entry) {
        if (Object.values(state.grants).some((g) => g.ticket === ticket && g.status === "reserved"))
          throw new IntentHeld("Ticket still has a reserved model grant");
        slots.releaseActive(state, entry);
      }
      t.merge = record;
      return { state, merge: record };
    });
  }
  result(t, extra = {}) {
    return { ticket: Number(t.number), pr: t.pr, head: t.head, merged: false, ...extra };
  }
  async reconcile(ticket, t, pr, { dryRun = false } = {}) {
    if (pr.merged !== true && pr.state !== "closed") return null;
    const merged = pr.merged === true;
    if (merged && (pr.state !== "closed" || !policy.SHA.test(pr.merge_commit_sha || "")))
      throw new Error("Merged PR has no verifiable merge commit");
    await this.issue(ticket, t, { merged, confirmation: true, observed: pr });
    const status = merged ? "merged" : "closed";
    if (
      !dryRun &&
      (t.merge?.status !== status || (merged && t.merge.mergeCommit !== pr.merge_commit_sha))
    ) {
      const record = this.record(status, t, merged ? pr.merge_commit_sha : undefined);
      try {
        await this.persist(ticket, t, record, t.merge);
      } catch (error) {
        if (!(error instanceof IntentHeld)) throw error;
        const current = await this.current(ticket, t);
        if (current.merge?.status !== status) throw error;
      }
    }
    return this.result(
      { ...t, number: ticket },
      {
        merged: !dryRun && merged,
        closed: !merged,
        ...(dryRun ? { dryRun: true, wouldMerge: false } : {}),
        ...(merged ? { mergeCommit: pr.merge_commit_sha } : {}),
      }
    );
  }
  async beforeWrite(ticket, expected, intent) {
    if (!this.enabled()) throw new Error("Automatic merge disabled");
    const t = await this.recheck("ledger", async () => {
      const current = await this.current(ticket, expected);
      if (!same(current.merge, intent)) throw new IntentHeld("Merge intent changed concurrently");
      return current;
    });
    const pr = await this.recheck("pr-identity", async () => {
      const current = await this.pr(ticket, t);
      await this.issue(ticket, t, { merged: current.merged === true });
      return current;
    });
    await this.recheck("saved-ci", () => this.ci(t));
    return { t, pr };
  }
  async recheck(_stage, check) {
    return check();
  }
  authorizeNewIntent(_ticket) {}
  unsentFailure(_ticket, _intent, _error) {
    return {};
  }
  async release(ticket, expected, intent, error) {
    await this.ledger.update((state) => {
      const t = this.stateTicket(state, ticket, expected);
      if (!same(t.merge, intent) || !this.mergeLock(state, ticket, intent))
        throw new IntentHeld("Cannot release another merge lock");
      slots.releaseActive(state, { ticket, runId: intent.runId, runAttempt: intent.runAttempt });
      // This method is called only before the PUT can be issued. Preserve the
      // unsent intent in audit so the next run may try fresh preflight checks.
      state.audit.push({
        at: new Date().toISOString(),
        event: "automatic_merge_not_sent",
        ticket,
        previousMergeIntent: t.merge,
        ...this.unsentFailure(t, intent, error),
      });
      delete t.merge;
      return { state };
    });
  }
  async receipt(ticket, expected, intent, receipt) {
    await this.ledger.update((state) => {
      const t = this.stateTicket(state, ticket, expected);
      if (!same(t.merge, intent) && !["merged", "closed"].includes(t.merge?.status))
        throw new IntentHeld("Merge intent changed before receipt");
      state.audit.push({
        at: new Date().toISOString(),
        event: "automatic_merge_api_result",
        ticket,
        pr: t.pr,
        head: t.head,
        runId: intent.runId,
        runAttempt: intent.runAttempt,
        ...receipt,
      });
      if (
        receipt.outcome === "accepted" &&
        t.merge?.status === "merged" &&
        receipt.mergeCommit !== t.merge.mergeCommit
      ) {
        state.audit.push({
          at: new Date().toISOString(),
          event: "automatic_merge_confirmation_conflict",
          ticket,
          previousMergeRecord: t.merge,
        });
        t.merge = intent;
        slots.claimActive(
          state,
          { ticket, runId: intent.runId, runAttempt: intent.runAttempt },
          this.config.concurrent
        );
      }
      return { state };
    });
  }
  latestReceipt(state, ticket, t) {
    return state.audit.findLast(
      (row) =>
        row.event === "automatic_merge_api_result" &&
        row.ticket === ticket &&
        row.head === t.head &&
        row.pr === t.pr
    );
  }
  checkReceipt(state, ticket, t, record) {
    const receipt = this.latestReceipt(state, ticket, t);
    if (
      record.status === "merged" &&
      receipt?.outcome === "accepted" &&
      receipt.mergeCommit !== record.mergeCommit
    )
      throw new Error("Merge confirmation disagrees with retained API receipt");
  }
  async confirm(ticket, expected, { dryRun = false } = {}) {
    let reason = "merge_confirmation_pending";
    for (let poll = 0; poll < (dryRun ? 1 : this.maxPolls); poll++) {
      if (poll) await this.sleep(5000);
      const { state } = await this.ledger.read();
      const t = this.stateTicket(state, ticket, expected);
      try {
        const receipt = this.latestReceipt(state, ticket, t);
        if (t.merge?.status === "intent" && !receipt) {
          // Another observer cannot race the in-flight writer's API response.
          let owner;
          try {
            owner = await this.api.request(
              "GET",
              `${ROOT}/actions/runs/${t.merge.runId}/attempts/${t.merge.runAttempt}`
            );
          } catch {
            throw new ConfirmationUnavailable();
          }
          if (owner.status !== "completed") continue;
        }
        const pr = await this.pr(ticket, t, { confirmation: true });
        reason = "merge_confirmation_pending";
        this.checkReceipt(state, ticket, t, {
          status: pr.merged === true ? "merged" : "pending",
          mergeCommit: pr.merge_commit_sha,
        });
        const terminal = await this.reconcile(ticket, t, pr, { dryRun });
        if (terminal) return terminal;
      } catch (error) {
        if (!(error instanceof ConfirmationUnavailable)) throw error;
        reason = "merge_confirmation_unavailable";
      }
    }
    return this.result(
      { ...expected, number: ticket },
      { pending: true, reason, ...(dryRun ? { dryRun: true, wouldMerge: false } : {}) }
    );
  }
  async permitWrite(ticket, t) {
    if (t.publishedRecovery?.parent)
      await require("./published-review-recovery.cjs").assertRecoveryBase(this.api, t);
  }
  async holdMovedBase(ticket, expected, dryRun) {
    const recovery = require("./published-review-recovery.cjs");
    if (!dryRun) {
      await this.ledger.update((state) => {
        const t = this.stateTicket(state, ticket, expected);
        if (t.merge || !t.publishedRecovery?.parent)
          throw new IntentHeld("Published recovery changed before recording the stale base");
        const entry = slots.activeFor(state, ticket);
        if (entry && !slots.owns(entry, { ...t.publishedRecovery.parent, ticket }))
          throw new IntentHeld("Another parent owns this published repair");
        if (entry) slots.releaseActive(state, entry);
        policy.audit(state, "published_review_base_changed", {
          ticket,
          head: t.head,
          previousApproval: t.approval,
        });
        t.status = "blocked";
        t.approval = null;
        t.feedback = recovery.STALE_REASON;
        recovery.recordStaleParent(t);
        return { state };
      });
    }
    return { ticket, merged: false, reason: recovery.STALE_REASON };
  }
  async restoreIntentOwnership(ticket, expected) {
    await this.ledger.update(async (state) => {
      const current = this.stateTicket(state, ticket, expected);
      if (current.merge?.status !== "intent" || !same(current.merge, expected.merge))
        throw new IntentHeld("Merge intent changed before ownership restoration");
      const owner = { ticket, runId: current.merge.runId, runAttempt: current.merge.runAttempt };
      const entry = slots.activeFor(state, ticket);
      if (entry && !slots.owns(entry, owner))
        throw new IntentHeld("Another parent owns this ticket");
      if (!entry) {
        if (!(await terminalParent(this.api, owner)))
          throw new IntentHeld("Original merge owner is not confirmed terminal");
        slots.claimActive(state, owner, this.config.concurrent);
        policy.audit(state, "automatic_merge_ownership_restored", { ticket, ...owner });
      }
      return { state };
    });
  }
  async merge(ticket, { dryRun = false } = {}) {
    this.authorize();
    if (!Number.isSafeInteger(ticket) || ticket < 1 || typeof dryRun !== "boolean")
      throw new Error("Invalid automatic merge request");
    if (!dryRun && !this.enabled())
      return { ticket, merged: false, reason: "Automatic merge disabled" };
    const { state } = await this.ledger.read();
    const candidate = this.automaticTicket(state, ticket);
    if (candidate.status !== "reviewed" && candidate.merge === undefined)
      return {
        ticket,
        merged: false,
        reason: "Ticket is not independently reviewed; nothing is ready to merge",
      };
    const t = this.stateTicket(state, ticket);
    // An existing intent may represent a completed write with a lost response.
    // Workflow terminality and still-open metadata never authorize a second PUT.
    if (t.merge?.status === "intent") {
      if (!dryRun && !slots.activeFor(state, ticket)) await this.restoreIntentOwnership(ticket, t);
      return this.confirm(ticket, t, { dryRun });
    }
    const pr = await this.recheck("pr-identity", () => this.pr(ticket, t));
    const terminal = await this.reconcile(ticket, t, pr, { dryRun });
    if (terminal) return terminal;
    if (["merged", "closed"].includes(t.merge?.status))
      throw new Error("Terminal merge record disagrees with current PR state");
    const recovery = require("./published-review-recovery.cjs");
    if (t.publishedRecovery?.parent) {
      try {
        await recovery.assertRecoveryBase(this.api, t);
      } catch (error) {
        if (error instanceof recovery.RecoveryStaleBase)
          return this.holdMovedBase(ticket, t, dryRun);
        throw error;
      }
    }
    const currentFeatureParent =
      recovery.recoveryParent(t, this.context) ||
      (t.automatic &&
        t.automatic.runId === this.context.runId &&
        t.automatic.runAttempt === this.context.runAttempt &&
        t.automatic.workflowSha === this.context.workflowSha);
    if (
      t.feature &&
      (t.feature.mode !== this.config.featureMode ||
        (!currentFeatureParent &&
          !slots.activeFor(state, ticket) &&
          (await require("./feature-priority.cjs").repairsWaiting(
            this.api,
            this.config,
            this.context,
            state
          ))))
    )
      return { ticket, merged: false, reason: "Feature merge paused by mode or ready repairs" };
    await this.recheck("pr-identity", () => this.issue(ticket, t));
    await this.recheck("saved-ci", () => this.ci(t));
    const gate = await this.recheck("required-checks", async () => {
      const proof = await this.checks(ticket, t, {
        waitForVerify:
          !dryRun &&
          (t.origin === "factory" || !!require("./dependency-contract.cjs").alertKey(t.branch)),
      });
      if (!proof.passed && !proof.failed)
        throw new Error("Native review gate is pending or unavailable");
      if (proof.passed) {
        const latest = proof.refreshedPR ?? pr;
        if (latest.mergeable !== true || latest.mergeable_state !== "clean")
          throw new Error("PR mergeability is not clean");
      }
      return proof;
    });
    if (dryRun)
      return this.result(
        { ...t, number: ticket },
        { dryRun: true, wouldMerge: gate.passed, needsRefresh: gate.failed }
      );
    const refresh = gate.passed
      ? undefined
      : await this.recheck("required-checks", async () => {
          const current = await this.current(ticket, t);
          await this.pr(ticket, current);
          await this.issue(ticket, current);
          await this.ci(current);
          const latestGate = await this.checks(ticket, current);
          if (
            !latestGate.failed ||
            latestGate.runId !== gate.runId ||
            latestGate.runAttempt !== gate.runAttempt ||
            !Number.isSafeInteger(gate.runAttempt) ||
            gate.runAttempt < 1 ||
            !Number.isSafeInteger(gate.runAttempt + 1)
          )
            throw new Error("Native metadata gate identity changed before refresh");
          const target = {
            runId: gate.runId,
            runAttempt: gate.runAttempt + 1,
            remainingPolls: this.maxPolls,
          };
          // Refresh only the metadata job. The CI and model runs remain unchanged.
          await this.api.request("POST", `${ROOT}/actions/runs/${gate.runId}/rerun-failed-jobs`);
          await this.waitForRefreshedGate(ticket, t, target, true);
          return target;
        });
    const intent = this.record("intent", t);
    try {
      await this.persist(ticket, t, intent, t.merge);
    } catch (error) {
      if (!(error instanceof IntentHeld)) throw error;
      const current = await this.current(ticket, t);
      return this.confirm(ticket, current);
    }
    try {
      const latest = await this.beforeWrite(ticket, t, intent);
      const completed = await this.reconcile(ticket, latest.t, latest.pr);
      if (completed) return completed;
      await this.recheck("required-checks", async () => {
        if (refresh) return this.waitForRefreshedGate(ticket, t, refresh);
        if (
          !(await this.checks(ticket, t)).passed ||
          latest.pr.state !== "open" ||
          latest.pr.mergeable !== true ||
          latest.pr.mergeable_state !== "clean"
        )
          throw new Error("Native checks or clean PR mergeability changed");
      });
      await this.recheck("dependency-evidence", () => this.permitWrite(ticket, t));
    } catch (error) {
      await this.release(ticket, t, intent, error);
      if (error instanceof recovery.RecoveryStaleBase) return this.holdMovedBase(ticket, t, false);
      throw error;
    }
    let receipt;
    try {
      const response = await this.api.request("PUT", `${ROOT}/pulls/${t.pr}/merge`, {
        sha: t.head,
        merge_method: "squash",
      });
      receipt = mergeReceipt(response);
    } catch (error) {
      receipt = mergeReceipt(null, error);
    }
    await this.receipt(ticket, t, intent, receipt);
    return this.confirm(ticket, t);
  }
}

module.exports = { AutomaticMerger };
