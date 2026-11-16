const policy = require("./policy.cjs");
const d = require("./dependency-contract.cjs");
const analysis = require("./dependency-analysis.cjs");
const lifecycle = require("./dependency-policy.cjs");
const { Ledger, ROOT } = require("./github.cjs");
const { Controller } = require("./controller.cjs");
const { AutomaticMerger } = require("./merge.cjs");
const { validateReview } = require("./artifacts.cjs");
const { ConfirmationUnavailable, readMergePR } = require("./merge-confirmation.cjs");

function expectedReport(ticket, context, stage) {
  const a = d.validateTicket(ticket);
  return {
    repository: policy.REPOSITORY,
    pr: ticket.pr,
    base: a.base,
    head: ticket.head,
    workflowSha: context.workflowSha,
    runId: context.runId,
    runAttempt: context.runAttempt,
    stage,
    toolDigest: analysis.toolDigest(),
  };
}
function artifactName(stage, context, ticket) {
  return `dependency-${stage}-${context.runId}-${context.runAttempt}-${ticket.pr}-${ticket.head}`;
}
async function trustedRun(api, context, historical = false) {
  if (!d.contextOK(context)) throw new Error("Unauthorized dependency context");
  const run = await api.request(
    "GET",
    `${ROOT}/actions/runs/${context.runId}${historical ? `/attempts/${context.runAttempt}` : ""}`
  );
  if (
    run.id !== Number(context.runId) ||
    run.path !== ".github/workflows/factory-dependencies.yml" ||
    run.head_sha !== context.workflowSha ||
    run.head_branch !== "main" ||
    run.repository?.full_name !== policy.REPOSITORY ||
    run.head_repository?.full_name !== policy.REPOSITORY ||
    run.actor?.login !== policy.OWNER ||
    run.triggering_actor?.login !== policy.OWNER ||
    run.run_attempt !== context.runAttempt ||
    !(historical
      ? ["schedule", "workflow_dispatch"].includes(run.event)
      : run.event === context.event)
  )
    throw new Error("Dependency producer run identity changed");
  return run;
}
async function producer(api, context, ticket, report, stage) {
  analysis.validateReport(report, expectedReport(ticket, context, stage));
  await trustedRun(api, context);
  const jobs = await api.pages(`${ROOT}/actions/runs/${context.runId}/jobs?filter=latest`, "jobs");
  const matching = jobs.filter((j) => j.name === stage);
  if (
    matching.length !== 1 ||
    matching[0].run_id !== Number(context.runId) ||
    matching[0].status !== "completed" ||
    matching[0].conclusion !== "success"
  )
    throw new Error("Dependency producer job did not succeed");
  const artifacts = await api.pages(`${ROOT}/actions/runs/${context.runId}/artifacts`, "artifacts");
  const matches = artifacts.filter((a) => a.name === artifactName(stage, context, ticket));
  if (
    matches.length !== 1 ||
    matches[0].expired !== false ||
    !Number.isSafeInteger(matches[0].size_in_bytes) ||
    matches[0].size_in_bytes < 1 ||
    matches[0].size_in_bytes > 65536 ||
    matches[0].workflow_run?.id !== Number(context.runId) ||
    matches[0].workflow_run?.head_sha !== context.workflowSha
  )
    throw new Error("Dependency report artifact producer mismatch");
}

class DependencyCoordinator {
  constructor(api, config, context) {
    this.api = api;
    this.config = config;
    this.context = context;
    this.ledger = new Ledger(api);
    this.controller = new Controller(api, config, context);
  }
  authorize() {
    policy.authorize(this.context);
    if (!d.contextOK(this.context)) throw new Error("Unauthorized dependency context");
  }
  async pending(t, preview) {
    let observed;
    try {
      observed = d.prOK(await readMergePR(this.api, t.pr, t.merge?.status === "intent"), true);
    } catch (error) {
      if (!(error instanceof ConfirmationUnavailable)) throw error;
      return { ready: false, reason: "merge_confirmation_unavailable" };
    }
    if (observed.number !== t.pr || observed.head.ref !== t.branch)
      throw new Error("Dependency PR identity changed");
    if (observed.head.sha !== t.head) {
      if (t.merge?.status === "intent")
        return {
          ready: false,
          reason: "Changed dependency head after uncertain merge requires owner reconciliation",
        };
      if (preview)
        return {
          ready: false,
          mode: "preview",
          ticket: t.pr,
          head: observed.head.sha,
          reason: "Bot changed reviewed head; live intake must invalidate stale approval",
        };
      // Without a merge intent this is a new candidate head. An uncertain merge
      // was handled above and must never retire its approval on this path.
      if (observed.state !== "open")
        return {
          ready: false,
          reason: "Changed closed dependency head requires owner reconciliation",
        };
      await this.ledger.update(async (s) => {
        policy.assertNotStopped(s);
        const current = s.tickets[String(t.pr)];
        if (
          JSON.stringify(current) !== JSON.stringify(t) ||
          Object.values(s.grants).some((g) => g.status === "reserved") ||
          (s.active &&
            !(
              t.merge?.status === "intent" &&
              s.active.ticket === t.pr &&
              s.active.runId === t.merge.runId &&
              s.active.runAttempt === t.merge.runAttempt
            ))
        )
          throw new Error("Dependency history changed during stale-proof reconciliation");
        const latest = d.prOK(await this.api.request("GET", `${ROOT}/pulls/${t.pr}`));
        if (
          latest.number !== t.pr ||
          latest.head.ref !== t.branch ||
          latest.head.sha !== observed.head.sha ||
          latest.head.sha === t.head
        )
          throw new Error("Dependency bot head changed during reconciliation");
        policy.audit(s, "dependency_stale_approval_retired", {
          ticket: t.pr,
          head: t.head,
          observedHead: latest.head.sha,
          grant: t.approval?.grant,
          ...(t.merge ? { mergeIntent: t.merge } : {}),
        });
        current.status = "blocked";
        current.approval = null;
        delete current.merge;
        if (s.active?.ticket === t.pr) s.active = null;
        return { state: s };
      });
      return null;
    }
    if (t.merge?.status === "intent")
      return { ready: !preview, mode: "reconcile", ticket: t.pr, head: t.head };
    const pr = await this.pr(t.pr, { closed: true, expected: t });
    return {
      ready: !preview,
      mode: pr.state === "closed" ? "reconcile" : "merge",
      ticket: t.pr,
      head: t.head,
    };
  }
  async pr(number, { closed = false, expected, confirmation = false } = {}) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid dependency PR");
    const pr = d.prOK(await readMergePR(this.api, number, confirmation), closed);
    if (
      pr.number !== number ||
      (expected && (pr.head.sha !== expected.head || pr.head.ref !== expected.branch))
    )
      throw new Error("Dependency head changed");
    if (pr.state === "open" && !confirmation) {
      d.filesOK(await this.api.request("GET", `${ROOT}/pulls/${number}/files?per_page=3`));
      const main = await this.api.request("GET", `${ROOT}/git/ref/heads/main`);
      const compare = await this.api.request(
        "GET",
        `${ROOT}/compare/${pr.base.sha}...${pr.head.sha}`
      );
      if (
        main.object?.sha !== pr.base.sha ||
        compare.behind_by !== 0 ||
        compare.merge_base_commit?.sha !== pr.base.sha ||
        (expected && pr.base.sha !== d.validateTicket(expected).base)
      )
        throw new Error("Dependency PR requires a current-main rebase");
    }
    return pr;
  }
  async select(preview = true) {
    this.authorize();
    if (typeof preview !== "boolean") throw new Error("Invalid dependency preview");
    if (!preview && (!this.config.enabled || !this.config.automatic))
      return { ready: false, reason: "Dependency factory disabled; no model invocation" };
    let { state } = await this.ledger.read();
    if (state.stop)
      return { ready: false, reason: "Factory stopped; explicit owner resume required" };
    if (state.active) {
      const t = state.tickets[String(state.active.ticket)];
      if (t?.dependency && t.status === "reviewed" && t.merge?.status === "intent") {
        const result = await this.pending(t, preview);
        if (result) return result;
        state = (await this.ledger.read()).state;
      }
      if (
        !preview &&
        t?.dependency &&
        !t.merge &&
        !Object.values(state.grants).some((g) => g.ticket === t.pr && g.head === t.head)
      ) {
        const attempt = d.validateTicket(t);
        const original = {
          ...this.context,
          workflowSha: attempt.workflowSha,
          runId: attempt.runId,
          runAttempt: attempt.runAttempt,
        };
        const run = await trustedRun(this.api, original, true);
        if (run.status === "completed") {
          await this.ledger.update((s) => ({
            state: lifecycle.finishPreparation(s, t.pr, original),
          }));
          state = (await this.ledger.read()).state;
        }
      }
      if (state.active) return { ready: false, reason: "An active ticket holds the factory lock" };
    }
    const pending = Object.values(state.tickets).find(
      (t) =>
        (t.automatic || t.dependency) &&
        t.status === "reviewed" &&
        !["closed", "merged"].includes(t.merge?.status)
    );
    if (pending) {
      if (!pending.dependency)
        return { ready: false, reason: "Pending app merge must be reconciled" };
      const result = await this.pending(pending, preview);
      if (result) return result;
      state = (await this.ledger.read()).state;
    }
    let candidate;
    for (let page = 1; page <= 5 && !candidate; page++) {
      const rows = await this.api.request(
        "GET",
        `${ROOT}/pulls?state=open&base=main&sort=created&direction=asc&per_page=100&page=${page}`
      );
      if (!Array.isArray(rows) || rows.length > 100)
        throw new Error("Invalid bounded dependency queue");
      for (const row of rows) {
        try {
          d.prOK(row);
        } catch {
          continue;
        }
        const previous = state.tickets[String(row.number)];
        if (
          previous &&
          (previous.origin !== "dependency-pr" ||
            previous.merge ||
            previous.dependency.attempts.some((a) => a.head === row.head.sha) ||
            previous.dependency.attempts.length >= Math.min(10, this.config.reviews) ||
            previous.reviews >= this.config.reviews)
        )
          continue;
        try {
          candidate = await this.pr(row.number);
          break;
        } catch {
          /* unsafe or outdated candidates remain held */
        }
      }
      if (rows.length < 100) break;
    }
    if (!candidate)
      return { ready: false, reason: "No eligible Dependabot PR in the bounded queue" };
    if (preview)
      return {
        ready: false,
        mode: "preview",
        ticket: candidate.number,
        head: candidate.head.sha,
        reason: "Preview only; no reservation, model session or merge",
      };
    await this.ledger.update(async (s) => ({
      state: lifecycle.claimDependency(
        s,
        await this.pr(candidate.number),
        this.context,
        this.config
      ),
    }));
    return { ready: true, mode: "review", ticket: candidate.number, head: candidate.head.sha };
  }
  async ticket(number, active = true) {
    this.authorize();
    const { state } = await this.ledger.read();
    policy.assertNotStopped(state);
    const t = state.tickets[String(number)];
    d.validateTicket(t);
    if (active) {
      d.matches(t, this.context, this.config);
      this.controller.activeRun(state, number);
    }
    await this.pr(number, { expected: t });
    return t;
  }
  async acceptAnalysis(number, report) {
    const t = await this.ticket(number);
    await producer(this.api, this.context, t, report, "analysis");
    await this.ledger.update((s) => {
      this.controller.activeRun(s, number);
      const current = s.tickets[String(number)];
      if (current.head !== t.head || current.analysis)
        throw new Error("Dependency analysis already recorded or head changed");
      current.analysis = report;
      return { state: s };
    });
    return { passed: true, ticket: number, head: t.head };
  }
  async reserve(number) {
    const t = await this.ticket(number);
    if (!(await this.controller.validateCI(t.ci?.runId, t.head, t.ci)).passed)
      throw new Error("Dependency CI failed");
    const result = await this.ledger.update((s) =>
      lifecycle.reserveDependencyReview(s, this.context, this.config)
    );
    return this.controller.result(result.grant);
  }
  async assess(number, grantId, bundle) {
    const t = await this.ticket(number);
    if (!(await this.controller.validateCI(t.ci?.runId, t.head, t.ci)).passed)
      throw new Error("Dependency CI failed");
    if (bundle?.kind !== "review" || bundle.grantId !== grantId || bundle.base !== t.head)
      throw new Error("Invalid dependency review artifact");
    const review = validateReview(bundle.result, t.head);
    await this.ledger.update((s) => {
      policy.preflight(
        s,
        grantId,
        { ...this.context, ticket: number, head: t.head, phase: "review", slot: "dependency" },
        this.config
      );
      const state = policy.finish(s, grantId, {
        status: review.verdict === "pass" ? "reviewed" : "blocked",
        head: t.head,
        pr: number,
        verdict: review.verdict,
        evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/${this.context.runId}`,
      });
      state.tickets[String(number)].feedback = JSON.stringify(review);
      return { state };
    });
    return { reviewed: review.verdict === "pass", ticket: number, head: t.head };
  }
  async finalize(number) {
    this.authorize();
    const { state } = await this.ledger.read();
    if (
      state.active?.ticket !== number ||
      state.active.runId !== this.context.runId ||
      state.active.runAttempt !== this.context.runAttempt
    )
      return { reason: "No preparation lease owned by this run" };
    const t = state.tickets[String(number)];
    d.matches(t, this.context, this.config);
    if (t.status === "reviewed" || t.merge)
      return { reason: "Reviewed or merge-intent history preserved" };
    if (Object.values(state.grants).some((g) => g.ticket === number && g.status === "reserved"))
      return this.controller.block(
        number,
        "Dependency subscription review unavailable; no automatic retry of this head"
      );
    await this.ledger.update((s) => ({
      state: lifecycle.finishPreparation(s, number, this.context),
    }));
    return { reason: "Dependency preparation held; admission retained and lock released" };
  }
}

class DependencyMerger extends AutomaticMerger {
  constructor(api, config, context, report, options) {
    super(api, config, context, options);
    this.report = report;
    this.coordinator = new DependencyCoordinator(api, config, context);
  }
  authorize() {
    this.coordinator.authorize();
  }
  automaticTicket(state, number) {
    const t = state.tickets[String(number)];
    d.validateTicket(t);
    if (t.pr !== number || t.dependency.appSlug !== this.config.appSlug)
      throw new Error("Dependency merge provenance changed");
    return t;
  }
  branchFor(_number, t) {
    return t.branch;
  }
  async issue(number, t, { confirmation = false, observed } = {}) {
    const current = await this.pr(number, t, { confirmation });
    if (
      confirmation &&
      (current.state !== observed.state ||
        current.merged !== observed.merged ||
        (observed.merged === true && current.merge_commit_sha !== observed.merge_commit_sha))
    )
      throw new ConfirmationUnavailable();
  }
  async permitWrite(number, t) {
    await this.pr(number, t);
    analysis.validateReport(this.report, expectedReport(t, this.context, "premerge"));
  }
  async pr(number, t, { confirmation = false } = {}) {
    const pr = await this.coordinator.pr(number, { closed: true, expected: t, confirmation });
    // Closed/lost-response reconciliation needs no fresh report or another model.
    if (pr.state === "open" && !confirmation)
      analysis.validateReport(this.report, expectedReport(t, this.context, "premerge"));
    return pr;
  }
  async merge(number, options) {
    this.authorize();
    if (!this.enabled()) return { merged: false, reason: "Dependency merge disabled" };
    const { state } = await this.ledger.read();
    const t = this.automaticTicket(state, number);
    if (t.merge?.status === "intent") return super.merge(number, options);
    const pr = await this.coordinator.pr(number, { closed: true, expected: t });
    if (pr.state === "open") await producer(this.api, this.context, t, this.report, "premerge");
    return super.merge(number, options);
  }
}
module.exports = {
  DependencyCoordinator,
  DependencyMerger,
  expectedReport,
  artifactName,
  producer,
  trustedRun,
};
