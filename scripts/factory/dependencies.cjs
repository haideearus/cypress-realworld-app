const slots = require("./active-tickets.cjs");
const { terminalParent } = require("./active-runs.cjs");
const policy = require("./policy.cjs");
const d = require("./dependency-contract.cjs");
const analysis = require("./dependency-analysis.cjs");
const lifecycle = require("./dependency-policy.cjs");
const { Ledger, ROOT } = require("./github.cjs");
const { Controller } = require("./controller.cjs");
const { AutomaticMerger } = require("./merge.cjs");
const { validateReview } = require("./artifacts.cjs");
const { ConfirmationUnavailable, readMergePR } = require("./merge-confirmation.cjs");
const {
  repairFilesOK,
  requestCompatibilityRefresh,
  validCompatibilityRefresh,
} = require("./dependency-compatibility.cjs");
const mergeRetry = require("./dependency-merge-retry.cjs");
const {
  verifyAlertPR,
  AlertAdmissionHold,
  heldMergeAllowed,
} = require("./dependency-alert-repair.cjs");

class StaleDependencyBase extends Error {
  constructor(currentMain, verifiedRefresh) {
    super("Dependency PR requires a current-main rebase");
    this.currentMain = currentMain;
    this.verifiedRefresh = verifiedRefresh;
  }
}

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
async function trustedRun(api, context, historicalTicket = null) {
  const historical = historicalTicket !== null;
  if (!historical && !d.contextOK(context)) throw new Error("Unauthorized dependency context");
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
    (!historical &&
      (run.actor?.login !== context.actor ||
        run.triggering_actor?.login !== context.triggeringActor)) ||
    run.run_attempt !== context.runAttempt ||
    !(historical
      ? ["schedule", "workflow_dispatch"].includes(run.event)
      : run.event === context.event)
  )
    throw new Error("Dependency producer run identity changed");
  if (historical) {
    const owner = [run.actor, run.triggering_actor].every((actor) => actor?.login === policy.OWNER);
    if (!owner) {
      const { verifyPreparationOrigin } = require("./trusted-wake.cjs");
      const { WakeStore } = require("./wake-store.cjs");
      if (
        !(await verifyPreparationOrigin(
          api,
          run,
          historicalTicket,
          d.validateTicket(historicalTicket),
          new WakeStore(api)
        ))
      )
        throw new Error("Unauthorized dependency producer");
    }
  }
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
  async alertHold(t, pr) {
    if (!d.alertKey(t.branch) || t.merge || pr.state !== "open") return null;
    if (!this.config.alertRepair) return "alert-repair-disabled";
    if (pr.head.sha === t.head) {
      const main = await this.api.request("GET", `${ROOT}/git/ref/heads/main`);
      if (!d.SHA.test(main.object?.sha || "")) throw Error("Invalid main revision");
      if (main.object.sha !== d.validateTicket(t).base) return "stale-base";
    }
    try {
      await verifyAlertPR(this.api, pr, this.config);
    } catch (error) {
      if (!(error instanceof AlertAdmissionHold)) throw error;
      return "ticket-held";
    }
    return null;
  }
  async pending(t, preview, now = new Date()) {
    if (!t.merge && mergeRetry.current(t)?.phase === "retrying")
      return { ready: false, reason: "Dependency merge retry is already claimed" };
    if (!preview && !t.merge && mergeRetry.due(t, now)) {
      if (!(await mergeRetry.claim(this.ledger, t, this.context, this.config, now)))
        return { ready: false, reason: "Dependency merge retry is already claimed or unavailable" };
      return { ready: true, mode: "merge", ticket: t.pr, head: t.head };
    }
    let observed;
    try {
      observed = d.prOK(
        await readMergePR(this.api, t.pr, t.merge?.status === "intent"),
        true,
        d.alertKey(t.branch) ? { ...this.config, alertRepair: true } : this.config
      );
    } catch (error) {
      if (!(error instanceof ConfirmationUnavailable)) throw error;
      return { ready: false, reason: "merge_confirmation_unavailable" };
    }
    if (observed.number !== t.pr || observed.head.ref !== t.branch)
      throw new Error("Dependency PR identity changed");
    const alertHold = await this.alertHold(t, observed);
    if (alertHold) {
      if (preview) return { ready: false, reason: alertHold };
      await this.ledger.update(async (s) => {
        policy.assertNotStopped(s);
        const current = s.tickets[String(t.pr)];
        const entry = slots.activeFor(s, t.pr);
        if (
          JSON.stringify(current) !== JSON.stringify(t) ||
          Object.values(s.grants).some((g) => g.ticket === t.pr && g.status === "reserved") ||
          (entry && !(await terminalParent(this.api, entry)))
        )
          throw Error("Alert proposal history changed");
        const latest = d.prOK(await readMergePR(this.api, t.pr), true, {
          ...this.config,
          alertRepair: true,
        });
        if (
          latest.number !== t.pr ||
          latest.head.ref !== t.branch ||
          latest.head.sha !== observed.head.sha ||
          (await this.alertHold(t, latest)) !== alertHold
        )
          throw Error("Alert proposal changed during hold");
        policy.audit(s, "dependency_alert_approval_retired", {
          ticket: t.pr,
          head: t.head,
          grant: t.approval?.grant,
          reason: alertHold,
        });
        current.status = "blocked";
        current.approval = null;
        if (entry) slots.releaseActive(s, entry);
        return { state: s };
      });
      return null;
    }
    let checked;
    let staleBase = false;
    if (
      observed.state === "open" &&
      observed.head.sha === t.head &&
      d.branch(t.branch) &&
      !t.merge
    ) {
      try {
        checked = await this.pr(t.pr, { expected: t });
      } catch (error) {
        if (!(error instanceof StaleDependencyBase)) throw error;
        staleBase = true;
      }
    }
    if (observed.head.sha !== t.head || staleBase) {
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
          reason: staleBase
            ? "Reviewed Dependabot PR needs a refresh on current main"
            : "Bot changed reviewed head; live intake must invalidate stale approval",
        };
      // The old approval is stale after a head or base change. An uncertain
      // merge must keep its approval for reconciliation.
      if (observed.state !== "open")
        return {
          ready: false,
          reason: "Changed closed dependency head requires owner reconciliation",
        };
      await this.ledger.update(async (s) => {
        policy.assertNotStopped(s);
        const current = s.tickets[String(t.pr)];
        const entry = slots.activeFor(s, t.pr);
        const attempt = d.validateTicket(t);
        const expectedOwner = {
          ticket: t.pr,
          runId: attempt.runId,
          runAttempt: attempt.runAttempt,
        };
        if (
          JSON.stringify(current) !== JSON.stringify(t) ||
          Object.values(s.grants).some((g) => g.ticket === t.pr && g.status === "reserved") ||
          (entry && (!slots.owns(entry, expectedOwner) || !(await terminalParent(this.api, entry))))
        )
          throw new Error("Dependency history changed during stale-proof reconciliation");
        const latest = d.prOK(
          await this.api.request("GET", `${ROOT}/pulls/${t.pr}`),
          false,
          this.config
        );
        await verifyAlertPR(this.api, latest, this.config);
        if (
          latest.number !== t.pr ||
          latest.head.ref !== t.branch ||
          latest.head.sha !== observed.head.sha ||
          latest.base.sha !== observed.base.sha
        )
          throw new Error("Dependency bot candidate changed during reconciliation");
        if (staleBase) {
          let stillStale = false;
          try {
            await this.pr(t.pr, { expected: t });
          } catch (error) {
            if (!(error instanceof StaleDependencyBase)) throw error;
            stillStale = true;
          }
          if (!stillStale) throw new Error("Dependency base changed during reconciliation");
        }
        policy.audit(s, "dependency_stale_approval_retired", {
          ticket: t.pr,
          head: t.head,
          observedHead: latest.head.sha,
          grant: t.approval?.grant,
          ...(staleBase ? { reason: "stale-base" } : {}),
          ...(t.merge ? { mergeIntent: t.merge } : {}),
        });
        current.status = "blocked";
        current.approval = null;
        delete current.merge;
        if (slots.activeFor(s, t.pr)) slots.releaseActive(s, slots.activeFor(s, t.pr));
        return { state: s };
      });
      return null;
    }
    if (t.merge?.status === "intent")
      return { ready: !preview, mode: "reconcile", ticket: t.pr, head: t.head };
    const pr = checked ?? (await this.pr(t.pr, { closed: true, expected: t }));
    if (mergeRetry.heldGate(t) && pr.state === "open") {
      if (preview)
        return { ready: false, mode: "preview", reason: "Saved review can resume at merge" };
      if (
        !(await mergeRetry.claim(this.ledger, t, this.context, this.config, now, (latest) =>
          this.pr(latest.pr, { expected: latest })
        ))
      )
        return { ready: false, reason: "Dependency merge retry is already claimed or unavailable" };
    }
    return {
      ready: !preview,
      mode: pr.state === "closed" ? "reconcile" : "merge",
      ticket: t.pr,
      head: t.head,
    };
  }
  async pr(number, { closed = false, expected, confirmation = false, history = expected } = {}) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid dependency PR");
    const observed = await readMergePR(this.api, number, confirmation);
    const reconciling = confirmation && expected?.merge?.status === "intent";
    const config =
      expected && (reconciling || (closed && observed.state === "closed"))
        ? { ...this.config, alertRepair: true }
        : this.config;
    const pr = d.prOK(observed, closed, config);
    if (
      pr.number !== number ||
      (expected && (pr.head.sha !== expected.head || pr.head.ref !== expected.branch))
    )
      throw new Error("Dependency head changed");
    const receipt = await verifyAlertPR(this.api, pr, config, undefined, reconciling);
    const source = d.compatibilityForHead(history);
    let compatibility = history?.head === pr.head.sha && source;
    let compatibilityRefresh;
    let base = receipt?.base ?? pr.base.sha;
    if (pr.state === "open" && !confirmation) {
      const main = await this.api.request("GET", `${ROOT}/git/ref/heads/main`);
      const currentMain = main.object?.sha;
      if (
        !receipt &&
        !compatibility &&
        source &&
        d.validateTicket(history).compatibilityRefreshes?.length
      ) {
        const commit = await this.api.request("GET", `${ROOT}/git/commits/${pr.head.sha}`);
        const mergedBase = commit.parents?.[1]?.sha;
        const refresh = {
          originalHead: history.head,
          head: pr.head.sha,
          base: mergedBase,
        };
        if (
          d.SHA.test(mergedBase || "") &&
          lifecycle.compatibilityRefreshRequested(history, history.head, mergedBase) &&
          (await validCompatibilityRefresh({
            api: this.api,
            pr,
            ...refresh,
            originalBase: d.validateTicket(history).base,
            allowAdvancedBase: true,
          }))
        ) {
          if (mergedBase !== currentMain)
            throw new StaleDependencyBase(currentMain, {
              ...pr,
              base: { ...pr.base, sha: mergedBase },
              compatibilityRefresh: refresh,
            });
          compatibility = source;
          compatibilityRefresh = refresh;
        }
      }
      if (compatibility)
        repairFilesOK(await this.api.request("GET", `${ROOT}/pulls/${number}/files?per_page=53`));
      else if (base === pr.base.sha)
        d.alertFilesOK(
          await this.api.request("GET", `${ROOT}/pulls/${number}/files?per_page=3`),
          receipt
        );
      if (!receipt && compatibility) base = currentMain;
      if (!d.SHA.test(base || "")) throw new StaleDependencyBase();
      const compare = await this.api.request("GET", `${ROOT}/compare/${base}...${pr.head.sha}`);
      if (
        main.object?.sha !== base ||
        compare.behind_by !== 0 ||
        compare.merge_base_commit?.sha !== base ||
        (expected && base !== d.validateTicket(expected).base)
      )
        throw new StaleDependencyBase(currentMain);
    }
    return {
      ...pr,
      base: { ...pr.base, sha: base },
      ...(compatibilityRefresh ? { compatibilityRefresh } : {}),
    };
  }
  async select(preview = true, now = new Date()) {
    this.authorize();
    if (typeof preview !== "boolean") throw new Error("Invalid dependency preview");
    if (!preview && (!this.config.enabled || !this.config.automatic))
      return { ready: false, reason: "Dependency factory disabled; no model invocation" };
    let { state } = await this.ledger.read();
    if (state.stop)
      return { ready: false, reason: "Factory stopped; explicit owner resume required" };
    const intentOwner = slots.pendingIntent(state);
    if (intentOwner) {
      if (!intentOwner.record.dependency)
        return { ready: false, reason: "Pending app merge intent must be reconciled" };
      const entry = slots.activeFor(state, intentOwner.ticket);
      if (state.version === 2 && entry && !(await terminalParent(this.api, entry)))
        return { ready: false, reason: "Merge intent parent is still running" };
      return this.pending(intentOwner.record, preview);
    }
    if (!preview && !this.context.wake && slots.usedCapacity(state) === 0) {
      const orphan = Object.values(state.tickets).find(lifecycle.unresolvedCompatibilityPublish);
      if (orphan) {
        const attempt = lifecycle.unresolvedCompatibilityPublish(orphan);
        if (await terminalParent(this.api, attempt)) {
          const recovered = await this.reconcileCompatibility(orphan, attempt);
          if (recovered) return recovered;
          state = (await this.ledger.read()).state;
        }
      }
    }
    const released = new Set();
    for (const entry of slots.activeEntries(state)) {
      const t = state.tickets[String(entry.ticket)];
      const publishing = lifecycle.unresolvedCompatibilityPublish(t);
      if (publishing && !preview && !this.context.wake && (await terminalParent(this.api, entry))) {
        const recovered = await this.reconcileCompatibility(t, publishing);
        if (recovered) return recovered;
        state = (await this.ledger.read()).state;
        released.add(entry.ticket);
        continue;
      }
      if (
        !publishing &&
        !preview &&
        (t?.dependency?.attempts?.at(-1).compatibility || d.compatibilityForHead(t)) &&
        Object.values(state.grants).some(
          (g) => g.ticket === entry.ticket && g.status === "reserved"
        ) &&
        (await terminalParent(this.api, entry))
      ) {
        await new Controller(this.api, this.config, {
          ...this.context,
          runId: entry.runId,
          runAttempt: entry.runAttempt,
        }).block(t.pr, "Dependency model parent ended before assessment; recorded usage retained");
        state = (await this.ledger.read()).state;
        released.add(entry.ticket);
        continue;
      }
      const retry = mergeRetry.current(t);
      if (
        !preview &&
        !t?.merge &&
        retry?.phase === "retrying" &&
        slots.owns(entry, { ticket: entry.ticket, ...retry.run }) &&
        (await terminalParent(this.api, entry))
      ) {
        await mergeRetry.finish(this.ledger, t, retry.run);
        state = (await this.ledger.read()).state;
        continue;
      }
      if (
        state.version === 2 &&
        t?.dependency &&
        t.status === "reviewed" &&
        mergeRetry.blocksQueue(t, now) &&
        !["closed", "merged"].includes(t.merge?.status) &&
        (await terminalParent(this.api, entry))
      ) {
        const result = await this.pending(t, preview, now);
        if (result) return result;
        state = (await this.ledger.read()).state;
      }
      if (t?.dependency && t.status === "reviewed" && t.merge?.status === "intent") {
        const result = await this.pending(t, preview);
        if (result) return result;
        state = (await this.ledger.read()).state;
      }
      if (
        !preview &&
        t?.dependency &&
        t.status !== "reviewed" &&
        !t.merge &&
        !publishing &&
        slots.owns(slots.activeFor(state, t.pr), entry) &&
        !Object.values(state.grants).some(
          (g) => g.ticket === t.pr && g.head === t.head && g.status === "reserved"
        )
      ) {
        const attempt = d.validateTicket(t);
        const original = {
          ...this.context,
          workflowSha: attempt.workflowSha,
          runId: attempt.runId,
          runAttempt: attempt.runAttempt,
        };
        const run = await trustedRun(this.api, original, t);
        if (run.status === "completed") {
          await this.ledger.update((s) => ({
            state: lifecycle.finishPreparation(s, t.pr, original),
          }));
          state = (await this.ledger.read()).state;
          released.add(entry.ticket);
        }
      }
    }
    if (!slots.capacity(state, this.config.concurrent))
      return { ready: false, reason: "An active ticket holds the factory lock" };
    const pending = Object.values(state.tickets).find(
      (t) =>
        (t.automatic || t.dependency) &&
        (!t.feature || slots.activeFor(state, t.feature.issue)) &&
        !t.findingApiRecovery &&
        t.status === "reviewed" &&
        (!t.dependency ||
          mergeRetry.blocksQueue(t, now) ||
          (this.config.autoMerge &&
            (mergeRetry.due(t, now) ||
              (mergeRetry.heldGate(t) &&
                policy.reviewGate(state, { number: t.pr, head: t.head }).ok)))) &&
        !["closed", "merged"].includes(t.merge?.status)
    );
    if (pending) {
      if (!pending.dependency)
        return { ready: false, reason: "Pending app merge must be reconciled" };
      if (state.version === 2 && slots.activeFor(state, pending.pr))
        return { ready: false, reason: "Reviewed dependency parent is still running" };
      const result = await this.pending(pending, preview, now);
      if (result && (result.ready || preview || !mergeRetry.heldGate(pending))) return result;
      state = (await this.ledger.read()).state;
      if (
        state.stop ||
        slots.pendingIntent(state) ||
        !slots.capacity(state, this.config.concurrent)
      )
        return { ready: false, reason: "Factory availability changed while checking a held merge" };
    }
    const target = require("./trusted-wake.cjs").dependencyWakeTarget(this.context);
    const compatibilityWake = target?.compatibility === true;
    const turns = require("./feature-turn.cjs");
    if (turns.priority(state, this.config)) return { ready: false, reason: turns.WAITING };
    if (this.context.wake && !target)
      return { ready: false, reason: "No exact dependency CI wake for a new review" };
    let candidate,
      generated,
      compatibilityRefresh,
      nativeTracking,
      recordedStaleRefresh = false;
    const holds = [];
    for (let page = 1; page <= 5 && !candidate; page++) {
      const rows = target
        ? [await readMergePR(this.api, target.number)]
        : await this.api.request(
            "GET",
            `${ROOT}/pulls?state=open&base=main&sort=created&direction=asc&per_page=100&page=${page}`
          );
      if (!Array.isArray(rows) || rows.length > 100)
        throw new Error("Invalid bounded dependency queue");
      for (const row of rows) {
        try {
          d.prOK(row, false, this.config);
        } catch {
          continue;
        }
        if (target && (row.number !== target.number || row.head.sha !== target.head)) continue;
        const previous = state.tickets[String(row.number)];
        if (slots.activeFor(state, row.number)) continue;
        if (
          previous &&
          (previous.origin !== "dependency-pr" ||
            previous.merge ||
            (previous.dependency.attempts.some((a) => a.head === row.head.sha) &&
              (released.has(row.number) ||
                (this.context.wake && !compatibilityWake) ||
                previous.status !== "blocked" ||
                !d.branch(row.head.ref))) ||
            previous.dependency.attempts.length >= 10 ||
            previous.reviews >= this.config.reviews)
        )
          continue;
        try {
          if (generated && d.alertKey(row.head.ref)) continue;
          const verified = await this.pr(row.number, { history: previous });
          if (
            target &&
            (verified.head.sha !== target.head ||
              (compatibilityWake && verified.base.sha !== target.base))
          )
            continue;
          if (
            previous?.dependency.attempts.some((a) => a.head === verified.head.sha) &&
            !lifecycle.canClaimCompatibility(
              previous,
              verified,
              this.config,
              Object.values(state.grants)
            ) &&
            !lifecycle.canResumeCompatibility(
              previous,
              verified,
              this.config,
              Object.values(state.grants)
            )
          )
            continue;
          if (d.alertKey(row.head.ref)) {
            if (
              !(await heldMergeAllowed(
                this.api,
                { branch: verified.head.ref, head: verified.head.sha, pr: verified.number },
                state
              ))
            )
              continue;
            generated = verified;
          } else {
            candidate = verified;
            break;
          }
        } catch (error) {
          if (error.verifiedRefresh && !preview && !this.context.wake && !recordedStaleRefresh) {
            const refreshed = error.verifiedRefresh;
            const saved = await this.ledger.update((s) => {
              const claimed = lifecycle.claimDependency(
                s,
                refreshed,
                this.context,
                this.config,
                new Date(),
                undefined,
                { refreshReceipt: refreshed.compatibilityRefresh }
              );
              return {
                state: lifecycle.finishPreparation(claimed, refreshed.number, this.context),
              };
            });
            state = saved.state;
            recordedStaleRefresh = true;
            continue;
          }
          if (
            !compatibilityRefresh &&
            !this.context.wake &&
            error instanceof StaleDependencyBase &&
            d.SHA.test(error.currentMain || "") &&
            d.branch(row.head.ref)
          ) {
            let refreshable;
            if (previous?.head === row.head.sha && d.compatibilityForHead(previous))
              refreshable = !lifecycle.compatibilityRefreshRequested(
                previous,
                previous.head,
                error.currentMain
              );
            else if (!preview) {
              const tracking = require("./dependency-tracking.cjs");
              nativeTracking ??= (
                await tracking.nativeTrackingStore(this.api).read({ allowMissing: true })
              ).state;
              refreshable = tracking.canRequestNativeBranchUpdate(
                nativeTracking.records[row.number],
                row,
                error.currentMain
              );
            }
            if (refreshable)
              compatibilityRefresh = {
                ticket: row.number,
                head: row.head.sha,
                base: error.currentMain,
              };
          }
          if (holds.length < 5)
            holds.push({
              pr: row.number,
              head: row.head.sha,
              code:
                error.message === "Dependency PR requires a current-main rebase"
                  ? "requires-current-main-rebase"
                  : "prerequisites-unavailable",
            });
        }
      }
      if (rows.length < 100) break;
    }
    if (
      !candidate &&
      generated &&
      !(await new (require("./automation.cjs").AutomaticCoordinator)(
        this.api,
        this.config,
        {}
      ).candidate(state))
    )
      candidate = generated;
    if (!candidate && generated)
      return { ready: false, reason: "App work takes priority over dependency alert repair" };
    if (!candidate && compatibilityRefresh && !preview)
      return { ready: true, mode: "compatibility-refresh", ...compatibilityRefresh };
    if (!candidate)
      return holds.length
        ? {
            ready: false,
            ticket: holds[0].pr,
            head: holds[0].head,
            holds,
            reason: "Dependabot proposals held; refresh or prerequisite verification required",
          }
        : { ready: false, reason: "No eligible dependency PR in the bounded queue" };
    if (preview)
      return {
        ready: false,
        mode: "preview",
        ticket: candidate.number,
        head: candidate.head.sha,
        reason: "Preview only; no reservation, model session or merge",
      };
    await this.ledger.update(async (s) => {
      const previous = s.tickets[candidate.number];
      const pr = await this.pr(candidate.number, { history: previous });
      if (pr.head.sha !== candidate.head.sha || pr.base.sha !== candidate.base.sha)
        throw new Error("Dependency candidate changed while claiming");
      const receipt = await verifyAlertPR(this.api, pr, this.config);
      if (
        receipt &&
        !(await heldMergeAllowed(
          this.api,
          { branch: pr.head.ref, head: pr.head.sha, pr: pr.number },
          s
        ))
      )
        throw Error("Daily held dependency merge limit reached");
      if (
        receipt &&
        (await new (require("./automation.cjs").AutomaticCoordinator)(
          this.api,
          this.config,
          {}
        ).candidate(s))
      )
        throw Error("App work takes priority over dependency alert repair");
      return {
        state: lifecycle.claimDependency(s, pr, this.context, this.config, new Date(), receipt, {
          compatibility:
            (!this.context.wake || compatibilityWake) &&
            lifecycle.canClaimCompatibility(previous, pr, this.config, Object.values(s.grants)),
          continuation:
            !this.context.wake &&
            lifecycle.canResumeCompatibility(previous, pr, this.config, Object.values(s.grants)),
          refreshReceipt: pr.compatibilityRefresh,
        }),
      };
    });
    return { ready: true, mode: "review", ticket: candidate.number, head: candidate.head.sha };
  }
  async refreshCompatibility(number, head, base) {
    this.authorize();
    if (this.context.wake)
      throw new Error("Compatibility refresh requires a scheduled or owner scan");
    const { state } = await this.ledger.read();
    const t = state.tickets[number];
    const pr = d.prOK(await readMergePR(this.api, number), false, this.config);
    if (!d.branch(pr.head.ref) || pr.number !== number || pr.head.sha !== head)
      throw new Error("Dependency compatibility refresh head changed");
    const stillAvailable = async () => {
      const { state: current } = await this.ledger.read();
      policy.assertNotStopped(current);
      if (
        !this.config.enabled ||
        !this.config.automatic ||
        slots.usedCapacity(current) !== 0 ||
        slots.pendingIntent(current)
      )
        throw new Error("Dependency branch refresh must wait for the active ticket");
    };
    const repaired = t?.head === head && d.compatibilityForHead(t);
    if (repaired && pr.head.ref !== t.branch)
      throw new Error("Dependency compatibility refresh branch changed");
    if (!repaired)
      d.filesOK(await this.api.request("GET", `${ROOT}/pulls/${number}/files?per_page=3`));
    return requestCompatibilityRefresh({
      api: this.api,
      pr,
      expectedHead: head,
      expectedBase: base,
      claim: async (evidence) => {
        await stillAvailable();
        if (!repaired)
          return require("./dependency-tracking.cjs").claimNativeBranchUpdate(
            this.api,
            pr,
            base,
            stillAvailable
          );
        const result = await this.ledger.update((s) => {
          if (lifecycle.compatibilityRefreshRequested(s.tickets[number], head, base))
            return { state: s, claimed: false };
          return {
            state: lifecycle.beginDependencyCompatibilityRefresh(
              s,
              number,
              this.context,
              this.config,
              evidence
            ),
            claimed: true,
          };
        });
        return result.claimed;
      },
    });
  }
  async reconcileCompatibility(ticket, attempt) {
    const pr = d.prOK(await readMergePR(this.api, ticket.pr), true, this.config);
    if (pr.number !== ticket.pr || pr.head.ref !== ticket.branch)
      throw new Error("Dependency compatibility recovery PR identity changed");
    const [ref, main] = await Promise.all([
      pr.state === "open"
        ? this.api.request(
            "GET",
            `${ROOT}/git/ref/heads/${ticket.branch.split("/").map(encodeURIComponent).join("/")}`
          )
        : Promise.resolve({ object: { sha: pr.head.sha } }),
      this.api.request("GET", `${ROOT}/git/ref/heads/main`),
    ]);
    if (ref.object?.sha !== pr.head.sha || !d.SHA.test(main.object?.sha || ""))
      throw new Error("Dependency compatibility recovery references unavailable");
    const head = attempt.compatibility.publish.head;
    const evidence = {
      grantId: attempt.compatibility.grantId,
      head,
      originalHead: attempt.head,
      base: attempt.base,
      observedHead: pr.head.sha,
      observedBase: main.object.sha,
      observedOpen: pr.state === "open",
      outcome:
        pr.head.sha === head
          ? "published"
          : pr.head.sha === attempt.head
            ? "not_published"
            : "changed",
    };
    const saved = await this.ledger.update((state) => ({
      state: lifecycle.reconcileDependencyCompatibility(
        state,
        ticket.pr,
        this.context,
        this.config,
        evidence
      ),
    }));
    if (
      pr.state === "open" &&
      slots.owns(slots.activeFor(saved.state, ticket.pr), {
        ...this.context,
        ticket: ticket.pr,
      })
    )
      return { ready: true, mode: "review", ticket: ticket.pr, head };
    return null;
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
  async reserve(number, packet) {
    const t = await this.ticket(number);
    const { verifyPacket } = require("./dependency-preflight.cjs");
    verifyPacket(t, packet);
    if (
      !(await this.controller.validateCI(t.ci.runId, t.head, t.ci, packet.ciEvidence.runAttempt))
        .passed
    )
      throw new Error("Dependency CI failed");
    const result = await this.ledger.update((s) => {
      this.controller.activeRun(s, number);
      verifyPacket(s.tickets[String(number)], packet);
      return lifecycle.reserveDependencyReview(s, this.context, this.config);
    });
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
    const gate = await this.controller.gate(number);
    return { reviewed: review.verdict === "pass" && gate.ok, ticket: number, head: t.head };
  }
  async finalize(number, outcome = {}) {
    this.authorize();
    const { state } = await this.ledger.read();
    if (
      outcome.premergeFailed === true &&
      (await mergeRetry.premergeFailed(
        this.ledger,
        state.tickets[number],
        this.context,
        outcome.head,
        outcome.premergeEvidence
      ))
    )
      return {
        reason: "Dependency premerge failed before sending a merge request; approval retained",
      };
    if (await mergeRetry.finish(this.ledger, state.tickets[number], this.context))
      return { reason: "Dependency merge retry ended before a merge was sent; approval retained" };
    if (!slots.owns(slots.activeFor(state, number), { ...this.context, ticket: number }))
      return { reason: "No preparation lease owned by this run" };
    const t = state.tickets[String(number)];
    if (t.status === "reviewed" || t.merge)
      return { reason: "Reviewed or merge-intent history preserved" };
    if (lifecycle.unresolvedCompatibilityPublish(t))
      return { reason: "Dependency branch write will be reconciled from its retained intent" };
    d.matches(t, this.context, this.config);
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
  ownsPremergeLease(state, number, ticket) {
    return (
      !ticket.merge &&
      mergeRetry.current(ticket)?.phase === "retrying" &&
      mergeRetry.permits(ticket, this.context) &&
      slots.owns(slots.activeFor(state, number), { ...this.context, ticket: number }) &&
      !Object.values(state.grants).some(
        (grant) => grant.ticket === number && grant.status === "reserved"
      )
    );
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
    const { state } = await this.ledger.read();
    if (!(await heldMergeAllowed(this.api, t, state)))
      throw Error("Daily held dependency merge limit reached");
    analysis.validateReport(this.report, expectedReport(t, this.context, "premerge"));
    if (!mergeRetry.permits(state.tickets[number], this.context))
      throw Error("Dependency merge retry ownership or time window ended");
  }
  async pr(number, t, { confirmation = false } = {}) {
    const pr = await this.coordinator.pr(number, { closed: true, expected: t, confirmation });
    // Closed/lost-response reconciliation needs no fresh report or another model.
    if (pr.state === "open" && !confirmation)
      analysis.validateReport(this.report, expectedReport(t, this.context, "premerge"));
    return pr;
  }
  async recheck(stage, check) {
    try {
      return await check();
    } catch (error) {
      throw new mergeRetry.MergeCheckFailure(stage, error);
    }
  }
  authorizeNewIntent(ticket) {
    if (!mergeRetry.permits(ticket, this.context))
      throw Error("Dependency merge retry ownership or time window ended");
  }
  unsentFailure(ticket, intent, error) {
    return mergeRetry.recordUnsent(ticket, intent, error);
  }
  async release(ticket, expected, intent, error) {
    try {
      return await super.release(ticket, expected, intent, error);
    } catch (cause) {
      if (!(error instanceof mergeRetry.MergeCheckFailure)) throw cause;
      error.ledgerDiagnostic = mergeRetry.describe(cause, "ledger");
      throw error;
    }
  }
  async merge(number, options) {
    this.authorize();
    if (!this.enabled()) return { merged: false, reason: "Dependency merge disabled" };
    const { state } = await this.ledger.read();
    const t = this.automaticTicket(state, number);
    if (t.merge?.status === "intent") return super.merge(number, options);
    let evidenceChecked = false;
    try {
      const pr = await this.recheck("pr-identity", () =>
        this.coordinator.pr(number, { closed: true, expected: t })
      );
      if (pr.state === "open") {
        if (!mergeRetry.permits(t, this.context))
          return {
            ticket: number,
            merged: false,
            reason: "Dependency merge retry is waiting or held",
          };
        if (
          !(await this.recheck("dependency-evidence", () => heldMergeAllowed(this.api, t, state)))
        )
          return {
            ticket: number,
            merged: false,
            reason: "Daily held dependency merge limit reached",
          };
        await this.recheck("dependency-evidence", () =>
          producer(this.api, this.context, t, this.report, "premerge")
        );
        evidenceChecked = true;
      }
      return await super.merge(number, options);
    } catch (error) {
      if (!options?.dryRun && this.report && !error?.ledgerDiagnostic) {
        try {
          await mergeRetry.initialFailure(this.ledger, t, this.context, error, {
            temporaryOnly: !evidenceChecked,
          });
        } catch (cause) {
          if (!(error instanceof mergeRetry.MergeCheckFailure)) throw cause;
          error.ledgerDiagnostic = mergeRetry.describe(cause, "ledger");
        }
      }
      throw error;
    }
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
