const policy = require("./policy.cjs");
const { Controller, criteriaHash } = require("./controller.cjs");
const { Ledger, ROOT } = require("./github.cjs");
const { validPath } = require("./artifacts.cjs");
const { verifyMonitorIssue } = require("./monitor-origin.cjs");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  mergeLock(state, ticket, merge) {
    return (
      merge?.status === "intent" &&
      state.active?.ticket === ticket &&
      state.active.runId === merge.runId &&
      state.active.runAttempt === merge.runAttempt &&
      !Object.values(state.grants).some((grant) => grant.status === "reserved")
    );
  }
  automaticTicket(state, ticket) {
    const t = state.tickets[String(ticket)];
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
    this.authorize();
    const t = this.automaticTicket(state, ticket);
    if (state.active && !this.mergeLock(state, ticket, t.merge))
      throw new Error("An active ticket holds the factory lock");
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
  async issue(ticket, t, { merged = false } = {}) {
    const issue = await this.api.request("GET", `${ROOT}/issues/${ticket}`);
    const monitor = t.monitor
      ? await verifyMonitorIssue(this.api, issue, { proof: t.monitor, requireActive: false })
      : null;
    if (
      issue.number !== ticket ||
      issue.pull_request ||
      (t.monitor ? !monitor : issue.user?.login !== policy.OWNER) ||
      (issue.state !== "open" && !(merged && issue.state === "closed")) ||
      criteriaHash(issue) !== t.criteriaHash
    )
      throw new Error("Current issue criteria, owner, or state changed");
  }
  async pr(ticket, t) {
    const pr = await this.api.request("GET", `${ROOT}/pulls/${t.pr}`);
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
    if (pr.state === "open") {
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
          pr.head?.ref === `agent/factory-${ticket.number}` &&
          pr.url === `https://api.github.com${ROOT}/pulls/${ticket.pr}` &&
          pr.head?.repo?.url === `https://api.github.com${ROOT}` &&
          pr.base?.ref === "main" &&
          pr.base?.repo?.url === `https://api.github.com${ROOT}`
      )
    );
  }
  async nativeCheck(checks, name, file, ticket, t) {
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
        run.head_branch !== `agent/factory-${ticket}` ||
        run.repository?.full_name !== policy.REPOSITORY ||
        run.head_repository?.full_name !== policy.REPOSITORY ||
        run.check_suite_id !== check.check_suite.id ||
        !this.associated(check.pull_requests, association) ||
        !this.associated(run.pull_requests, association)
      )
        throw new Error(`Native check does not belong to its trusted PR workflow: ${name}`);
      const jobs = await this.api.pages(`${ROOT}/actions/runs/${runId}/jobs?filter=latest`, "jobs");
      const matching = jobs.filter(
        (job) =>
          job.id === Number(match[2]) &&
          job.run_id === runId &&
          job.name === name &&
          job.check_run_url === `https://api.github.com${ROOT}/check-runs/${check.id}`
      );
      if (matching.length !== 1)
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
      return { passed, failed, runId };
    }
    throw new Error(`Missing native required check: ${name}`);
  }
  async checks(ticket, t) {
    const checks = await this.api.pages(
      `${ROOT}/commits/${t.head}/check-runs?filter=all`,
      "check_runs"
    );
    const verify = await this.nativeCheck(checks, "verify", "factory-ci.yml", ticket, t);
    if (!verify.passed) throw new Error("Native required verify check is not successful");
    return this.nativeCheck(checks, "Factory review gate", "factory-review-status.yml", ticket, t);
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
    return this.ledger.update((state) => {
      const t = this.stateTicket(state, ticket, expected);
      if (!same(t.merge, previous)) throw new IntentHeld("Merge intent changed concurrently");
      if (record.status === "intent")
        state.active = { ticket, runId: record.runId, runAttempt: record.runAttempt };
      else if (this.mergeLock(state, ticket, previous)) state.active = null;
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
    await this.issue(ticket, t, { merged });
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
    const t = await this.current(ticket, expected);
    if (!same(t.merge, intent)) throw new IntentHeld("Merge intent changed concurrently");
    const pr = await this.pr(ticket, t);
    await this.issue(ticket, t, { merged: pr.merged === true });
    await this.ci(t);
    return { t, pr };
  }
  async release(ticket, expected, intent) {
    await this.ledger.update((state) => {
      const t = this.stateTicket(state, ticket, expected);
      if (!same(t.merge, intent) || !this.mergeLock(state, ticket, intent))
        throw new IntentHeld("Cannot release another merge lock");
      state.active = null;
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
    const pr = await this.pr(ticket, t);
    const terminal = await this.reconcile(ticket, t, pr, { dryRun });
    if (terminal) return terminal;
    if (["merged", "closed"].includes(t.merge?.status))
      throw new Error("Terminal merge record disagrees with current PR state");
    await this.issue(ticket, t);
    await this.ci(t);
    if (t.merge?.status === "intent") {
      if (t.merge.runId === this.context.runId && t.merge.runAttempt === this.context.runAttempt)
        return this.result(
          { ...t, number: ticket },
          { pending: true, ...(dryRun ? { dryRun } : {}) }
        );
      const previous = await this.api.request(
        "GET",
        `${ROOT}/actions/runs/${t.merge.runId}/attempts/${t.merge.runAttempt}`
      );
      if (previous.status !== "completed")
        return this.result(
          { ...t, number: ticket },
          { pending: true, ...(dryRun ? { dryRun } : {}) }
        );
    }
    let gate = await this.checks(ticket, t);
    if (!gate.passed && !gate.failed)
      throw new Error("Native review gate is pending or unavailable");
    if (gate.passed && (pr.mergeable !== true || pr.mergeable_state !== "clean"))
      throw new Error("PR mergeability is not clean");
    if (dryRun)
      return this.result(
        { ...t, number: ticket },
        { dryRun: true, wouldMerge: gate.passed, needsRefresh: gate.failed }
      );
    if (!gate.passed) {
      const current = await this.current(ticket, t);
      await this.pr(ticket, current);
      await this.issue(ticket, current);
      await this.ci(current);
      const latestGate = await this.checks(ticket, current);
      if (!latestGate.failed || latestGate.runId !== gate.runId)
        throw new Error("Native metadata gate identity changed before refresh");
      // Only the native metadata job is safe to rerun: never CI, code, or review models.
      await this.api.request("POST", `${ROOT}/actions/runs/${gate.runId}/rerun-failed-jobs`);
      for (let poll = 0; poll < this.maxPolls; poll++) {
        await this.sleep(5000);
        await this.current(ticket, t);
        gate = await this.checks(ticket, t);
        if (gate.passed) break;
      }
      if (!gate.passed) throw new Error("Timed out waiting for the native review gate refresh");
    }
    const intent = this.record("intent", t);
    try {
      await this.persist(ticket, t, intent, t.merge);
    } catch (error) {
      if (!(error instanceof IntentHeld)) throw error;
      const current = await this.current(ticket, t);
      const actual = await this.pr(ticket, current);
      return (
        (await this.reconcile(ticket, current, actual)) ||
        this.result({ ...t, number: ticket }, { pending: true })
      );
    }
    try {
      const latest = await this.beforeWrite(ticket, t, intent);
      const completed = await this.reconcile(ticket, latest.t, latest.pr);
      if (completed) return completed;
      gate = await this.checks(ticket, t);
      if (!gate.passed || latest.pr.mergeable !== true || latest.pr.mergeable_state !== "clean")
        throw new Error("Native checks or clean PR mergeability changed");
    } catch (error) {
      await this.release(ticket, t, intent);
      throw error;
    }
    try {
      await this.api.request("PUT", `${ROOT}/pulls/${t.pr}/merge`, {
        sha: t.head,
        merge_method: "squash",
      });
    } catch {
      // A timeout or lost response can follow a successful merge. Observe GitHub first.
    }
    const current = await this.current(ticket, t);
    const actual = await this.pr(ticket, current);
    return (
      (await this.reconcile(ticket, current, actual)) ||
      this.result({ ...t, number: ticket }, { pending: true })
    );
  }
}

module.exports = { AutomaticMerger };
