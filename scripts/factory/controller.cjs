const fs = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const policy = require("./policy.cjs");
const recovery = require("./recovery.cjs");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const { validateChanges, validateReview, secretLike } = require("./artifacts.cjs");
const criteriaHash = (issue) =>
  createHash("sha256")
    .update(JSON.stringify([issue.title, issue.body || ""]))
    .digest("hex");
function nextCycleSlot(slot) {
  const match = typeof slot === "string" && /^cycle([1-9]\d*)$/.exec(slot);
  const cycle = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(cycle) || cycle < 1 || cycle > policy.MAX_CODING_ATTEMPTS)
    throw new Error("Invalid coding cycle slot");
  return cycle === policy.MAX_CODING_ATTEMPTS ? null : `cycle${cycle + 1}`;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const identity = (ctx, extra = {}) => ({ ...ctx, ...extra });
class Controller {
  constructor(api, config, context, { sleep = delay, maxPolls = 180 } = {}) {
    this.api = api;
    this.ledger = new Ledger(api);
    this.config = config;
    this.context = context;
    this.sleep = sleep;
    this.maxPolls = maxPolls;
  }
  authorize() {
    policy.authorize(this.context);
  }
  async initialize() {
    this.authorize();
    return this.ledger.initialize();
  }
  async issue(ticket) {
    if (!Number.isSafeInteger(ticket) || ticket < 1) throw new Error("Invalid ticket");
    const issue = await this.api.request("GET", `${ROOT}/issues/${ticket}`);
    if (
      issue.state !== "open" ||
      issue.pull_request ||
      typeof issue.title !== "string" ||
      issue.title.length > 300 ||
      (issue.body || "").length > 20000 ||
      secretLike(issue.title + "\n" + (issue.body || ""))
    )
      throw new Error("Ticket is not an eligible open issue");
    return issue;
  }
  result(grant) {
    return {
      ready: true,
      grantId: grant.id,
      head: grant.head,
      ticket: grant.ticket,
      phase: grant.phase,
      slot: grant.slot,
    };
  }
  async admit(ticket, { recover = false } = {}) {
    this.authorize();
    const automatic = policy.isAutomaticContext(this.context);
    if (!this.config.enabled)
      return { ready: false, reason: "Factory disabled; no model invocation" };
    if (automatic && !this.config.automatic)
      return { ready: false, reason: "Automatic factory disabled; no model invocation" };
    if (typeof recover !== "boolean") throw new Error("Invalid recovery operation");
    if (automatic && recover) throw new Error("Automatic admission cannot request recovery");
    const issue = await this.issue(ticket);
    if (
      automatic &&
      (issue.user?.login !== policy.OWNER ||
        !issue.labels?.some(
          (label) => (typeof label === "string" ? label : label?.name) === "factory-ready"
        ))
    )
      throw new Error("Automatic admission needs an owner-created factory-ready issue");
    const main = await this.api.request("GET", `${ROOT}/branches/main`);
    const snapshot = await this.ledger.read();
    const previous = snapshot.state.tickets[String(ticket)];
    if (automatic && previous) throw new Error("Automatic ticket already admitted");
    if (previous?.pr) await this.matchingPR(previous);
    try {
      const ref = await this.api.request("GET", `${ROOT}/git/ref/heads/agent/factory-${ticket}`);
      if (!previous?.pr || ref.object?.sha !== previous.head)
        throw new Error(
          "Orphaned publication branch or changed agent head; owner recovery required"
        );
    } catch (error) {
      if (error.status !== 404) throw error;
      if (previous?.pr) throw new Error("Published agent branch is missing");
    }
    const saved = await this.ledger.update((state) => {
      const existing = state.tickets[String(ticket)];
      if (automatic && existing) throw new Error("Automatic ticket already admitted");
      if (
        automatic &&
        Object.entries(state.tickets).some(
          ([id, other]) =>
            id !== String(ticket) &&
            other.automatic &&
            other.origin === "factory" &&
            other.status === "reviewed" &&
            !["merged", "closed"].includes(other.merge?.status)
        )
      )
        throw new Error("Pending automatic merge must be reconciled");
      if (existing?.criteriaHash && existing.criteriaHash !== criteriaHash(issue))
        throw new Error("Ticket criteria changed; owner must review a new ticket");
      const request = identity(this.context, {
        ticket,
        phase: "code",
        slot: "cycle1",
        head:
          recover || (existing?.status === "blocked" && !existing.pr)
            ? main.commit.sha
            : existing?.head || main.commit.sha,
        ...(recover ? { recovery: recovery.ID } : {}),
      });
      const result = policy.reserve(state, request, this.config);
      result.state.tickets[String(ticket)].criteriaHash = criteriaHash(issue);
      if (automatic)
        result.state.tickets[String(ticket)].automatic = {
          workflowRef: this.context.workflowRef,
          workflowSha: this.context.workflowSha,
          runId: this.context.runId,
          runAttempt: this.context.runAttempt,
          appSlug: this.config.appSlug,
        };
      return result;
    });
    return this.result(saved.grant);
  }
  async currentTicket(ticket) {
    const loaded = await this.ledger.read();
    const t = loaded.state.tickets[String(ticket)];
    if (!t) throw new Error("Ticket has no usage reservation");
    return { ...loaded, ticket: t };
  }
  async admitPR(ticket, prNumber) {
    this.authorize();
    if (!this.config.enabled)
      return { ready: false, reason: "Factory disabled; no model invocation" };
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("Invalid owner PR");
    const issue = await this.issue(ticket);
    const pr = await this.api.request("GET", `${ROOT}/pulls/${prNumber}`);
    if (
      pr.state !== "open" ||
      pr.user?.login !== policy.OWNER ||
      pr.head?.repo?.full_name !== policy.REPOSITORY ||
      pr.base?.ref !== "main" ||
      !policy.SHA.test(pr.head?.sha || "") ||
      !pr.head?.ref
    )
      throw new Error("Review needs an open owner-authored PR in this repository targeting main");
    const saved = await this.ledger.update((state) => {
      const previous = state.tickets[String(ticket)];
      if (previous?.criteriaHash && previous.criteriaHash !== criteriaHash(issue))
        throw new Error("Ticket criteria changed; owner must review a new ticket");
      const result = policy.reserve(
        state,
        identity(this.context, {
          ticket,
          phase: "review",
          slot: "existing",
          origin: "owner-pr",
          pr: prNumber,
          head: pr.head.sha,
        }),
        this.config
      );
      const current = result.state.tickets[String(ticket)];
      current.criteriaHash = criteriaHash(issue);
      current.branch = pr.head.ref;
      current.ci = null;
      return result;
    });
    return this.result(saved.grant);
  }
  async matchingPR(t) {
    if (!t.pr) throw new Error("No published PR");
    const pr = await this.api.request("GET", `${ROOT}/pulls/${t.pr}`);
    if (
      pr.state !== "open" ||
      pr.head?.sha !== t.head ||
      pr.head?.repo?.full_name !== policy.REPOSITORY ||
      pr.base?.ref !== "main"
    )
      throw new Error("Published PR head or repository changed");
    if (
      policy.isAutomaticContext(this.context) &&
      (t.automatic?.appSlug !== this.config.appSlug ||
        pr.user?.login !== `${this.config.appSlug}[bot]`)
    )
      throw new Error("Automatic publisher must be the configured GitHub App");
    return pr;
  }
  async publish(grantId, bundle) {
    this.authorize();
    const loaded = await this.ledger.read();
    const grant = loaded.state.grants[grantId];
    if (!grant) throw new Error("Missing coding reservation");
    policy.preflight(
      loaded.state,
      grantId,
      identity(this.context, {
        ticket: grant.ticket,
        phase: "code",
        slot: grant.slot,
        head: grant.head,
      }),
      this.config
    );
    if (
      bundle?.kind !== "code" ||
      bundle.grantId !== grantId ||
      bundle.base !== grant.head ||
      typeof bundle.evidence !== "string" ||
      !bundle.evidence.trim() ||
      bundle.evidence.length > 20000 ||
      secretLike(bundle.evidence)
    )
      throw new Error("Invalid coding artifact");
    validateChanges(bundle.files);
    const t = loaded.state.tickets[String(grant.ticket)];
    const branch = `agent/factory-${grant.ticket}`;
    const previousPR = t.pr ? await this.matchingPR(t) : null;
    let branchExists = false;
    try {
      const ref = await this.api.request("GET", `${ROOT}/git/ref/heads/${branch}`);
      branchExists = true;
      if (!t.pr || ref.object?.sha !== grant.head)
        throw new Error("Agent branch collision or changed head");
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (t.pr && !branchExists) throw new Error("Published branch disappeared");
    const baseCommit = await this.api.request("GET", `${ROOT}/git/commits/${grant.head}`);
    const tree = [];
    for (const f of bundle.files) {
      if (f.deleted) tree.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      else {
        const blob = await this.api.request("POST", `${ROOT}/git/blobs`, {
          content: f.content,
          encoding: "utf-8",
        });
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      }
    }
    const createdTree = await this.api.request("POST", `${ROOT}/git/trees`, {
      base_tree: typeof baseCommit.tree === "string" ? baseCommit.tree : baseCommit.tree.sha,
      tree,
    });
    const commit = await this.api.request("POST", `${ROOT}/git/commits`, {
      message: `Factory repair for ticket #${grant.ticket}`,
      tree: createdTree.sha,
      parents: [grant.head],
    });
    if (branchExists)
      await this.api.request("PATCH", `${ROOT}/git/refs/heads/${branch}`, {
        sha: commit.sha,
        force: false,
      });
    else
      await this.api.request("POST", `${ROOT}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      });
    const pr = t.pr
      ? previousPR
      : await this.api.request("POST", `${ROOT}/pulls`, {
          head: branch,
          base: "main",
          draft: false,
          title: `Factory repair for #${grant.ticket}`,
          body: `Maintenance ticket: #${grant.ticket}\n\nAI coding evidence (untrusted until checked):\n\n${bundle.evidence}\n\nIndependent review and required CI are pending. This PR does not deploy production.`,
        });
    if (policy.isAutomaticContext(this.context) && pr.user?.login !== `${this.config.appSlug}[bot]`)
      throw new Error("Automatic publisher must be the configured GitHub App");
    await this.ledger.update((state) => {
      policy.preflight(
        state,
        grantId,
        identity(this.context, {
          ticket: grant.ticket,
          phase: "code",
          slot: grant.slot,
          head: grant.head,
        }),
        this.config
      );
      const next = policy.finish(state, grantId, {
        status: "awaiting_review",
        head: commit.sha,
        pr: pr.number,
      });
      next.tickets[String(grant.ticket)].branch = branch;
      return { state: next };
    });
    return { ready: true, pr: pr.number, head: commit.sha, ticket: grant.ticket };
  }
  activeRun(state, ticket) {
    if (
      !state.active ||
      state.active.ticket !== ticket ||
      state.active.runId !== this.context.runId ||
      state.active.runAttempt !== this.context.runAttempt
    )
      throw new Error("Operation belongs to another active run");
  }
  async validateCI(runId, head, reservation) {
    if (!Number.isSafeInteger(runId) || runId < 1) throw new Error("Invalid CI run ID");
    if (
      !reservation ||
      reservation.runId !== runId ||
      reservation.head !== head ||
      !/^[a-f0-9-]{36}$/.test(reservation.requestId || "")
    )
      throw new Error("CI run does not match its durable dispatch reservation");
    const run = await this.api.request("GET", `${ROOT}/actions/runs/${runId}`);
    if (
      run.head_sha !== head ||
      run.display_title !== `Factory CI / ${reservation.requestId}` ||
      run.event !== "workflow_dispatch" ||
      run.path !== ".github/workflows/factory-ci.yml" ||
      run.status !== "completed"
    )
      throw new Error("CI does not cover the expected head");
    const jobs = await this.api.pages(`${ROOT}/actions/runs/${runId}/jobs`, "jobs");
    const verified = jobs.filter((job) => job.name === "verify");
    return {
      passed:
        run.conclusion === "success" &&
        verified.length === 1 &&
        verified[0].status === "completed" &&
        verified[0].conclusion === "success",
      runId,
      head,
    };
  }
  async ci(ticket) {
    this.authorize();
    if (!this.config.enabled) throw new Error("Factory disabled");
    const { ticket: t } = await this.currentTicket(ticket);
    await this.matchingPR(t);
    const requestId = randomUUID();
    await this.ledger.update((state) => {
      this.activeRun(state, ticket);
      const current = state.tickets[String(ticket)];
      if (current.head !== t.head || current.ci?.head === t.head)
        throw new Error("CI dispatch already reserved or head changed; owner recovery required");
      current.ci = { requestId, head: t.head, runId: null };
      return { state };
    });
    await this.api.request("POST", `${ROOT}/actions/workflows/factory-ci.yml/dispatches`, {
      ref: t.branch || `agent/factory-${ticket}`,
      inputs: { factory_request_id: requestId },
    });
    for (let count = 0; count < this.maxPolls; count++) {
      const runs = await this.api.pages(
        `${ROOT}/actions/workflows/factory-ci.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(t.branch || `agent/factory-${ticket}`)}`,
        "workflow_runs"
      );
      const matching = runs
        .filter(
          (run) =>
            run.head_sha === t.head &&
            run.event === "workflow_dispatch" &&
            run.display_title === `Factory CI / ${requestId}`
        )
        .sort((a, b) => b.id - a.id);
      if (matching.length > 1) throw new Error("Ambiguous CI dispatch identity");
      const run = matching[0];
      if (run?.status === "completed") {
        const reservation = { requestId, head: t.head, runId: run.id };
        const verified = await this.validateCI(run.id, t.head, reservation);
        const saved = await this.ledger.update((state) => {
          this.activeRun(state, ticket);
          const current = state.tickets[String(ticket)];
          if (current.head !== t.head || current.ci?.requestId !== requestId)
            throw new Error("CI reservation changed during verification");
          current.ci = { ...reservation, passed: verified.passed };
          return { state, ci: current.ci };
        });
        return { ...verified, requestId: saved.ci.requestId };
      }
      await this.sleep(10000);
    }
    throw new Error("Timed out waiting for the exact-head CI run");
  }
  async reserveReview(ticket, ciId, slot) {
    this.authorize();
    const { ticket: t } = await this.currentTicket(ticket);
    await this.matchingPR(t);
    const ci = await this.validateCI(ciId, t.head, t.ci);
    if (!ci.passed) throw new Error("CI failed; independent review not admitted");
    const result = await this.ledger.update((state) => {
      const current = state.tickets[String(ticket)];
      if (current.head !== t.head) throw new Error("Ledger head changed");
      return policy.reserve(
        state,
        identity(this.context, { ticket, phase: "review", slot, head: t.head }),
        this.config
      );
    });
    return this.result(result.grant);
  }
  async block(ticket, reason) {
    await this.ledger.update((original) => {
      const state = structuredClone(original);
      const active = state.active;
      if (
        !active ||
        active.ticket !== ticket ||
        active.runId !== this.context.runId ||
        active.runAttempt !== this.context.runAttempt
      )
        throw new Error("Cannot finish another active run");
      for (const g of Object.values(state.grants))
        if (g.ticket === ticket && g.status === "reserved") {
          g.status = "finished";
          g.outcome = "blocked";
        }
      const t = state.tickets[String(ticket)];
      t.status = "blocked";
      t.approval = null;
      t.feedback = reason;
      state.active = null;
      policy.audit(state, "blocked", { ticket, reason });
      return { state };
    });
    return { retry: false, reason };
  }
  async assess(ticket, results, ciId, reviewGrantId, bundle, slot) {
    this.authorize();
    if (
      results.coding !== "success" ||
      results.publication !== "success" ||
      results.ci !== "success"
    )
      return this.block(
        ticket,
        "Agent, publication, or CI infrastructure failed; no automatic model retry"
      );
    const { ticket: t } = await this.currentTicket(ticket);
    await this.matchingPR(t);
    const ci = await this.validateCI(ciId, t.head, t.ci);
    if (ci.passed) {
      if (results.review !== "success")
        return this.block(
          ticket,
          "Review unavailable, interrupted, or subscription quota exhausted"
        );
      if (bundle?.kind !== "review" || bundle.grantId !== reviewGrantId || bundle.base !== t.head)
        throw new Error("Invalid review artifact identity");
      const review = validateReview(bundle.result, t.head);
      await this.ledger.update((state) => {
        policy.preflight(
          state,
          reviewGrantId,
          identity(this.context, { ticket, phase: "review", slot, head: t.head }),
          this.config
        );
        const status = review.verdict === "pass" ? "reviewed" : "retry";
        const next = policy.finish(state, reviewGrantId, {
          status,
          head: t.head,
          pr: t.pr,
          verdict: review.verdict,
          evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/${this.context.runId}`,
        });
        next.tickets[String(ticket)].feedback = JSON.stringify(review);
        return { state: next };
      });
      if (review.verdict === "pass") {
        await this.gate(t.pr);
        return { retry: false, reviewed: true, pr: t.pr, head: t.head };
      }
    } else {
      await this.ledger.update((original) => {
        const state = structuredClone(original);
        const active = state.active;
        if (
          !active ||
          active.ticket !== ticket ||
          active.runId !== this.context.runId ||
          active.runAttempt !== this.context.runAttempt
        )
          throw new Error("CI belongs to another active run");
        state.tickets[String(ticket)].feedback =
          `Required verify failed: https://github.com/${policy.REPOSITORY}/actions/runs/${ciId}`;
        state.tickets[String(ticket)].status = "retry";
        return { state };
      });
    }
    const nextSlot = nextCycleSlot(slot);
    if (nextSlot === null) return this.block(ticket, "Automatic retry pipeline limit reached");
    try {
      const reserved = await this.ledger.update((state) =>
        policy.reserve(
          state,
          identity(this.context, { ticket, phase: "code", slot: nextSlot, head: t.head }),
          this.config
        )
      );
      return { ...this.result(reserved.grant), retry: true };
    } catch (error) {
      if (/limit reached|disabled/i.test(error.message))
        return this.block(ticket, "Ticket allowance exhausted or factory disabled");
      throw error;
    }
  }
  async cancel() {
    this.authorize();
    const { state } = await this.ledger.read();
    const active = state.active;
    if (!active) return { canceled: false, reason: "No active ticket" };
    if (active.runId === this.context.runId)
      throw new Error("Cancellation must run separately from the active factory run");
    const path = `${ROOT}/actions/runs/${active.runId}`;
    let run = await this.api.request("GET", `${path}/attempts/${active.runAttempt}`);
    if (run.status !== "completed") {
      await this.api.request("POST", `${path}/cancel`);
      for (let n = 0; n < 12; n++) {
        run = await this.api.request("GET", `${path}/attempts/${active.runAttempt}`);
        if (run.status === "completed") break;
        await this.sleep(5000);
      }
    }
    if (run.status !== "completed")
      throw new Error("Run is still active; retaining the ticket lock");
    await this.ledger.update((original) => {
      const next = structuredClone(original);
      if (JSON.stringify(next.active) !== JSON.stringify(active))
        throw new Error("Active ticket changed during cancellation");
      for (const grant of Object.values(next.grants))
        if (grant.ticket === active.ticket && grant.status === "reserved") {
          grant.status = "finished";
          grant.outcome = "blocked";
        }
      next.tickets[String(active.ticket)].status = "blocked";
      next.tickets[String(active.ticket)].approval = null;
      next.active = null;
      policy.audit(next, "owner-canceled", {
        ticket: active.ticket,
        actor: this.context.actor,
        runId: active.runId,
      });
      return { state: next };
    });
    return { canceled: true, ticket: active.ticket };
  }
  async assessPR(ticket, results, ciId, grantId, bundle) {
    this.authorize();
    const { ticket: t } = await this.currentTicket(ticket);
    if (t.origin !== "owner-pr") throw new Error("Not an owner PR review ticket");
    await this.matchingPR(t);
    if (results.ci !== "success" || results.review !== "success")
      return this.block(
        ticket,
        "Owner PR CI or subscription review unavailable; no automatic retry"
      );
    const ci = await this.validateCI(ciId, t.head, t.ci);
    if (!ci.passed) return this.block(ticket, "Owner PR CI failed; review cannot approve");
    if (bundle?.kind !== "review" || bundle.grantId !== grantId || bundle.base !== t.head)
      throw new Error("Invalid owner review artifact identity");
    const review = validateReview(bundle.result, t.head);
    await this.ledger.update((state) => {
      policy.preflight(
        state,
        grantId,
        identity(this.context, {
          ticket,
          phase: "review",
          slot: "existing",
          head: t.head,
        }),
        this.config
      );
      const next = policy.finish(state, grantId, {
        status: review.verdict === "pass" ? "reviewed" : "blocked",
        head: t.head,
        pr: t.pr,
        verdict: review.verdict,
        evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/${this.context.runId}`,
      });
      next.tickets[String(ticket)].feedback = JSON.stringify(review);
      return { state: next };
    });
    await this.gate(t.pr);
    return { retry: false, reviewed: review.verdict === "pass", pr: t.pr, head: t.head };
  }
  async gate(prNumber) {
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("Invalid PR number");
    const pr = await this.api.request("GET", `${ROOT}/pulls/${prNumber}`);
    if (!policy.SHA.test(pr.head?.sha || "")) throw new Error("Invalid PR head");
    let result = { ok: false, reason: "Independent review ledger unavailable" };
    try {
      result = policy.reviewGate((await this.ledger.read()).state, {
        number: prNumber,
        head: pr.head.sha,
      });
    } catch {}
    if (pr.base?.ref !== "main" || pr.head.repo?.full_name !== policy.REPOSITORY)
      result = { ok: false, reason: "PR has no admitted factory review" };
    await this.api.request("POST", `${ROOT}/check-runs`, {
      name: "Factory review evidence",
      head_sha: pr.head.sha,
      status: "completed",
      conclusion: result.ok ? "success" : "failure",
      output: {
        title: result.ok ? "Fresh independent review verified" : "Independent review required",
        summary: result.reason,
      },
    });
    return result;
  }
}
function runtimeContext(env = process.env) {
  return {
    repository: env.GITHUB_REPOSITORY,
    actor: env.GITHUB_ACTOR,
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR,
    ref: env.GITHUB_REF,
    event: env.GITHUB_EVENT_NAME,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    ticket: 1,
    phase: "code",
    slot: "cycle1",
    head: "0".repeat(40),
  };
}
function readJson(path, max = 600000) {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw new Error("Invalid factory artifact file");
  return JSON.parse(fs.readFileSync(path, "utf8"));
}
function output(values, env = process.env) {
  for (const [key, value] of Object.entries(values)) {
    if (!["string", "number", "boolean"].includes(typeof value)) continue;
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new Error("Invalid workflow output");
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${key}=${text}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `Factory operation finished. ${values.reason || ""}\n`
    );
}
async function main(env = process.env) {
  const inputs = JSON.parse(env.FACTORY_INPUTS || "{}");
  const operation = env.FACTORY_OPERATION || inputs.operation;
  const config = policy.readConfig(JSON.parse(env.FACTORY_VARIABLES || "{}"));
  policy.assertSubscriptionEnv(env);
  if (operation === "validate") {
    const result = {
      validated: true,
      enabled: config.enabled,
      ready: false,
      reason: "Configuration validated; no ledger access or model invocation",
    };
    output(result, env);
    return result;
  }
  const api = new GitHub({ token: env.GH_TOKEN });
  const context = runtimeContext(env);
  const controller = new Controller(api, config, context);
  const ticket = Number(inputs.ticket);
  let result;
  switch (operation) {
    case "initialize":
      await controller.initialize();
      result = { initialized: true };
      break;
    case "admit":
      result = await controller.admit(ticket, { recover: inputs.operation === "recover" });
      break;
    case "admit_pr":
      result = await controller.admitPR(ticket, Number(inputs.pr));
      break;
    case "publish":
      result = await controller.publish(inputs.grantId, readJson(env.FACTORY_BUNDLE_PATH));
      break;
    case "ci":
      result = await controller.ci(ticket);
      break;
    case "review":
      result = await controller.reserveReview(ticket, Number(inputs.ciId), inputs.slot);
      break;
    case "assess":
      result = await controller.assess(
        ticket,
        inputs.results,
        Number(inputs.ciId),
        inputs.reviewGrantId,
        env.FACTORY_BUNDLE_PATH && fs.existsSync(env.FACTORY_BUNDLE_PATH)
          ? readJson(env.FACTORY_BUNDLE_PATH)
          : null,
        inputs.slot
      );
      break;
    case "cancel":
      result = await controller.cancel();
      break;
    case "assess_pr":
      result = await controller.assessPR(
        ticket,
        inputs.results,
        Number(inputs.ciId),
        inputs.grantId,
        env.FACTORY_BUNDLE_PATH && fs.existsSync(env.FACTORY_BUNDLE_PATH)
          ? readJson(env.FACTORY_BUNDLE_PATH)
          : null
      );
      break;
    case "gate":
      result = await controller.gate(Number(inputs.pr));
      break;
    default:
      throw new Error("Unknown factory operation");
  }
  output(result, env);
  return result;
}
if (require.main === module)
  main().catch((error) => {
    console.error(
      secretLike(error.message) ? "Factory operation refused" : error.message.slice(0, 240)
    );
    process.exitCode = 1;
  });
module.exports = {
  Controller,
  criteriaHash,
  nextCycleSlot,
  runtimeContext,
  readJson,
  output,
  main,
};
