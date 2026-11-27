const test = require("node:test");
const assert = require("node:assert/strict");
let wake;
try {
  wake = require("../factory/wake-controller.cjs");
} catch (e) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
}
const { fixture, receiverSetup } = require("./helpers/event-fixtures.cjs");

test("wake receipts have a trusted implementation", () => assert.ok(wake));
test("owner issue wake records intent before one dispatch; duplicate events never dispatch twice", async () => {
  const s = fixture();
  const first = await wake.handleWake(s);
  assert.equal(first.outcome, "dispatched");
  assert.equal(s.dispatches.length, 1);
  assert.equal(s.intentAtDispatch.status, "intent");
  assert.equal(s.dispatches[0].ref, "main");
  assert.equal(s.dispatches[0].inputs.dry_run, false);
  assert.equal((await wake.handleWake(s)).outcome, "duplicate");
  assert.equal(s.dispatches.length, 1);
});
test("preview and absent opt-in cannot dispatch or initialize metadata", async () => {
  for (const changes of [{ preview: true }, { vars: {} }]) {
    const s = Object.assign(fixture(), changes);
    await wake.handleWake(s);
    assert.equal(s.dispatches.length, 0);
    assert.equal(s.store.writes, 0);
  }
});
test("foreign issues, comment events, closed issues and edited admitted criteria cannot wake coding", async () => {
  for (const change of [
    (s) => (s.issue.user.login = "stranger"),
    (s) => (s.event.action = "commented"),
    (s) => (s.issue.state = "closed"),
    (s) => (s.ledger.state.tickets["12"] = { criteriaHash: "f".repeat(64) }),
  ]) {
    const s = fixture();
    change(s);
    assert.equal((await wake.handleWake(s)).outcome, "ignored");
    assert.equal(s.dispatches.length, 0);
  }
});
test("full capacity retains a pending signal without dispatch or a model reservation", async () => {
  const s = fixture();
  s.ledger.state.active = { ticket: 9, runId: "9", runAttempt: 1 };
  assert.equal((await wake.handleWake(s)).outcome, "busy");
  assert.equal(s.dispatches.length, 0);
  assert.equal(Object.values(s.store.state.receipts)[0].status, "pending");
  assert.deepEqual(s.ledger.state.grants, {});
});
test("an uncertain POST is retained and never retried blindly", async () => {
  const s = fixture();
  s.uncertain = true;
  assert.equal((await wake.handleWake(s)).outcome, "uncertain");
  assert.equal((await wake.handleWake(s)).outcome, "duplicate");
  assert.equal(s.dispatches.length, 1);
  assert.equal(Object.values(s.store.state.receipts)[0].status, "intent");
});
test("stop blocks wake and never changes usage state", async () => {
  const s = fixture();
  s.ledger.state.stop = {};
  const before = structuredClone(s.ledger.state);
  assert.equal((await wake.handleWake(s)).outcome, "stopped");
  assert.deepEqual(s.ledger.state, before);
  assert.equal(s.dispatches.length, 0);
});

test("only a real bot dispatch can bind an intent and survive policy reservation without impersonating owner", async () => {
  const {
    verifyWake,
    isTrustedWakeContext,
    allowedModelBots,
  } = require("../factory/trusted-wake.cjs");
  const p = require("../factory/policy.cjs");
  const { vars } = require("./helpers/factory-fixtures.cjs");
  const s = await receiverSetup();
  s.store.state.receipts[s.receiptId].status = "intent";
  const proof = await verifyWake({ ...s, lane: "app", bind: true });
  const context = {
    ...s.context,
    wake: proof,
    ticket: 12,
    head: "a".repeat(40),
    phase: "code",
    slot: "cycle1",
  };
  assert.equal(isTrustedWakeContext(context), true);
  const config = p.readConfig({
    ...vars,
    FACTORY_EVENT_PICKUP_ENABLED: "true",
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
    FACTORY_GITHUB_APP_SLUG: "fixture-factory",
  });
  const result = p.reserve(p.emptyState(s.context.repository), context, config);
  assert.equal(result.state.audit.at(-1).actor, "github-actions[bot]");
  assert.equal(s.store.state.receipts[s.receiptId].receiver.runId, "900");
  const ticket = result.state.tickets["12"];
  ticket.automatic = {
    workflowRef: context.workflowRef,
    workflowSha: context.workflowSha,
    runId: context.runId,
    runAttempt: context.runAttempt,
    appSlug: config.appSlug,
  };
  assert.equal(p.preflight(result.state, result.grant.id, context, config).id, result.grant.id);
  assert.equal(allowedModelBots(context, ticket), "github-actions[bot]");
  assert.equal(allowedModelBots({ ...context, phase: "review" }, ticket), "github-actions[bot]");
  for (const invalid of [
    { ...context, wake: undefined },
    { ...context, wake: JSON.parse(JSON.stringify(proof)) },
    { ...context, runId: "901" },
    { ...context, runAttempt: 2 },
    { ...context, actor: "another[bot]" },
    { ...context, triggeringActor: "haideearus" },
    { ...context, workflowRef: context.workflowRef.replace("automatic", "dependencies") },
  ])
    assert.equal(allowedModelBots(invalid, ticket), "");
  for (const outsideScope of [
    { ...ticket, automatic: undefined },
    { ...ticket, finding: {} },
    { ...ticket, origin: "dependency-pr" },
    { ...ticket, origin: "drill" },
    { ...ticket, origin: "owner-pr" },
  ])
    assert.equal(allowedModelBots(context, outsideScope), "");
  assert.equal(
    isTrustedWakeContext({ ...context, wake: JSON.parse(JSON.stringify(proof)) }),
    false
  );
});
test("forged actor, rerun, workflow path/SHA, changed source and failed producer fail closed", async () => {
  const { verifyWake } = require("../factory/trusted-wake.cjs");
  for (const mutate of [
    (s) => (s.context.actor = "stranger"),
    (s) => (s.context.runAttempt = 2),
    (s) => (s.receiver.path = ".github/workflows/factory-agents.yml"),
    (s) => (s.receiver.head_sha = "f".repeat(40)),
    (s) => (s.issue.body = "changed acceptance criteria"),
    (s) => Object.assign(s.run, { status: "completed", conclusion: "failure" }),
  ]) {
    const s = await receiverSetup();
    mutate(s);
    await assert.rejects(verifyWake({ ...s, lane: "app", bind: true }));
    assert.equal(s.store.state.receipts[s.receiptId].receiver, null);
  }
});
test("a receipt admits one receiver only, including when receiver beats producer acknowledgment", async () => {
  const { verifyWake } = require("../factory/trusted-wake.cjs");
  const s = await receiverSetup();
  s.store.state.receipts[s.receiptId].status = "intent";
  await verifyWake({ ...s, lane: "app", bind: true });
  s.context.runId = "901";
  s.receiver.id = 901;
  const base = s.api.request;
  s.api.request = (m, p, b) =>
    p.includes("/runs/901/") ? Promise.resolve(s.receiver) : base(m, p, b);
  await assert.rejects(verifyWake({ ...s, lane: "app", bind: true }), /bound|receiver/);
  assert.equal(s.store.state.receipts[s.receiptId].receiver.runId, "900");
});
test("retained bound provenance remains verifiable after its issue closes, without admitting a new receiver", async () => {
  const { verifyWake } = require("../factory/trusted-wake.cjs");
  const s = await receiverSetup();
  await verifyWake({ ...s, lane: "app", bind: true });
  s.issue.state = "closed";
  await verifyWake({ ...s, lane: "app", bind: false });
  assert.equal(s.store.state.receipts[s.receiptId].receiver.runId, "900");
});
test("an activity observer sees an early receipt as pending without binding or authorizing it", async () => {
  const { isTrustedWakeContext } = require("../factory/trusted-wake.cjs");
  const { observeRun } = require("../factory/activity-observer.cjs");
  const s = await receiverSetup();
  s.store.state.receipts[s.receiptId].status = "intent";
  const base = s.api.request;
  s.api.request = (m, p, b) =>
    p.endsWith("/git/ref/heads/factory/wakes")
      ? Promise.resolve({ object: { sha: "b".repeat(40) } })
      : p.includes("/contents/wakes.json")
        ? Promise.resolve({
            type: "file",
            encoding: "base64",
            content: Buffer.from(JSON.stringify(s.store.state)).toString("base64"),
          })
        : base(m, p, b);
  s.api.pages = async () => [];
  const writes = s.store.writes;
  assert.equal(
    (await observeRun({ ...s, runId: 900, runAttempt: 1, preview: true })).outcome,
    "awaiting_binding"
  );
  assert.equal(s.store.writes, writes);
  assert.equal(isTrustedWakeContext(s.context), false);
  await require("../factory/trusted-wake.cjs").verifyWake({ ...s, lane: "app", bind: true });
  assert.equal(
    (await observeRun({ ...s, runId: 900, runAttempt: 1, preview: true })).outcome,
    "preview"
  );
});

async function discoveryDrainFixture(sourceRun = "850") {
  const p = require("../factory/policy.cjs");
  const d = require("../factory/discovery-contract.cjs");
  const c = require("../factory/wake-contract.cjs");
  const { vars } = require("./helpers/factory-fixtures.cjs");
  const s = fixture();
  const sourceAt = new Date("2026-11-21T21:48:50Z");
  const day = "2026-11-21";
  const charter = "functional-notifications";
  const discovery = {
    version: 1,
    day,
    charter,
    head: s.context.workflowSha,
    ciRunId: "849",
    runId: sourceRun,
    runAttempt: 1,
    workflowSha: s.context.workflowSha,
    workflowRef: d.WORKFLOW_REF,
    key: d.sweepKey(s.context.workflowSha, charter, day),
  };
  const grant = p.reserve(
    p.emptyState(c.REPOSITORY),
    {
      ...s.context,
      event: "workflow_run",
      actor: d.FACTORY_APP,
      triggeringActor: d.FACTORY_APP,
      workflowRef: d.WORKFLOW_REF,
      runId: sourceRun,
      ticket: 168,
      head: s.context.workflowSha,
      phase: "discover",
      slot: "discovery",
      origin: "discovery-sweep",
      discovery,
    },
    { ...p.readConfig(vars), discovery: true, automatic: true },
    sourceAt
  );
  s.ledger.state = p.finish(grant.state, grant.grant.id, { status: "discovery_complete" });
  const run = {
    ...s.run,
    id: Number(sourceRun),
    workflow_id: 85,
    path: ".github/workflows/factory-discovery.yml",
    event: "workflow_run",
    actor: { login: d.FACTORY_APP, id: 356310548, type: "Bot" },
    triggering_actor: { login: d.FACTORY_APP, id: 356310548, type: "Bot" },
    status: "completed",
    conclusion: "success",
  };
  s.context.event = "workflow_run";
  s.run.event = "workflow_run";
  s.event = { repository: { full_name: c.REPOSITORY }, action: "completed", workflow_run: run };
  const base = s.api.request;
  s.api.request = async (method, path, body) => {
    if (method === "GET" && path.endsWith(`/actions/runs/${sourceRun}/attempts/1`))
      return structuredClone(run);
    if (
      method === "GET" &&
      /\/actions\/workflows\/factory-(?:discovery|automatic)\.yml$/.test(path)
    )
      return { id: 85, path: ".github/workflows/" + path.split("/").at(-1) };
    if (method === "GET" && path.endsWith("/git/ref/heads/factory/state"))
      return { object: { sha: "b".repeat(40) } };
    if (method === "GET" && path.includes("/contents/state.json?"))
      return {
        type: "file",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(s.ledger.state)).toString("base64"),
      };
    return base(method, path, body);
  };
  return { ...s, drainRun: run };
}

function queueNativeCI(s, number, runId, mode = "current") {
  const c = require("../factory/wake-contract.cjs");
  const { criteria } = require("../factory/dependency-contract.cjs");
  const actor = { login: "dependabot[bot]", id: 49699333 };
  const head = "d".repeat(40);
  const ciPath = ".github/workflows/factory-ci.yml";
  const receipt = c.createWake({
    signal: {
      kind: "dependency-ci",
      lane: "dependency",
      number,
      head,
      criteriaHash: criteria(number),
      revision: mode === "old-base" ? "f".repeat(40) : s.context.workflowSha,
      sourceRun: String(runId),
      sourceAttempt: 1,
      actor,
    },
    producer: {
      runId: s.context.runId,
      runAttempt: 1,
      workflowSha: s.context.workflowSha,
      actor: s.run.actor,
      event: "workflow_run",
    },
  });
  s.store.state.receipts[receipt.id] = receipt;
  const repo = { full_name: s.context.repository };
  const request = s.api.request;
  s.api.request = async (method, path, body) => {
    if (method === "GET" && path.endsWith(`/pulls/${number}`)) {
      if (mode === "unavailable") throw Object.assign(Error("GitHub unavailable"), { status: 502 });
      return {
        number,
        state: "open",
        draft: false,
        user: { ...actor, type: "Bot" },
        head: {
          sha: mode === "stale" ? "e".repeat(40) : head,
          ref: `dependabot/npm_and_yarn/demo-${number}`,
          repo,
        },
        base: { sha: s.context.workflowSha, ref: "main", repo },
      };
    }
    if (method === "GET" && path.endsWith(`/pulls/${number}/files?per_page=3`))
      return [{ filename: "yarn.lock", status: "modified" }];
    if (method === "GET" && path.endsWith("/actions/workflows/factory-ci.yml"))
      return { id: 70, path: ciPath };
    if (method === "GET" && path.endsWith(`/actions/runs/${runId}/attempts/1`))
      return {
        ...s.run,
        id: runId,
        workflow_id: 70,
        path: ciPath,
        event: "pull_request",
        head_sha: head,
        status: "completed",
        conclusion: "success",
        actor: mode === "wrong-actor" ? s.run.actor : actor,
        pull_requests: [{ number }],
      };
    return request(method, path, body);
  };
  s.api.pages = async () => [{ name: "verify", status: "completed", conclusion: "success" }];
  return receipt.id;
}

function scheduledWake(s) {
  s.context.event = s.run.event = "schedule";
  s.run.created_at = new Date().toISOString();
  s.event = { repository: s.run.repository };
  return s;
}

test("a scheduled check picks one verified wake left pending by Dependency maintenance #165", async () => {
  const s = scheduledWake(fixture());
  s.ledger.state.tickets[299] = {
    origin: "dependency-pr",
    status: "reviewed",
    dependencyMergeRetry: { phase: "held", retryAt: null },
  };
  s.ledger.state.grants["review-299"] = {
    ticket: 299,
    runId: "46066424823",
    status: "finished",
  };
  const stale = queueNativeCI(s, 221, 703, "old-base");
  const forged = queueNativeCI(s, 230, 704, "wrong-actor");
  const first = queueNativeCI(s, 233, 706);
  const second = queueNativeCI(s, 258, 707);
  for (const id of [stale, forged, first, second])
    s.store.state.receipts[id].producer.runId = "799";
  const request = s.api.request.bind(s.api);
  s.api.request = (method, route, body) => {
    if (/\/runs\/799\/attempts\/1$/.test(route))
      return { ...s.run, id: 799, event: "workflow_run" };
    if (route.includes("/compare/"))
      return { behind_by: 0, merge_base_commit: { sha: s.context.workflowSha } };
    return request(method, route, body);
  };
  const before = structuredClone(s.ledger.state);
  const outcomes = await Promise.all([wake.handleWake(s), wake.handleWake(s)]);
  assert.equal(outcomes.filter((result) => result.outcome === "dispatched").length, 1);
  assert.deepEqual(s.dispatches, [{ ref: "main", inputs: { wake_id: first, preview: false } }]);
  assert.equal(s.store.state.receipts[stale].status, "observed");
  assert.equal(s.store.state.receipts[forged].status, "pending");
  assert.equal(s.store.state.receipts[first].producer.runId, "799");
  assert.equal(s.store.state.receipts[second].status, "pending");
  assert.deepEqual(s.ledger.state, before);
});

test("a scheduled check retains queued work while a worker or an unresolved merge owns it", async () => {
  for (const apply of [
    (state) => (state.active = { ticket: 299, runId: "46066424823", runAttempt: 1 }),
    (state) => (state.tickets[299] = { merge: { status: "intent" } }),
    (state) => (state.stop = {}),
  ]) {
    const s = scheduledWake(fixture());
    apply(s.ledger.state);
    const ready = queueNativeCI(s, 233, 706);
    await wake.handleWake(s);
    assert.deepEqual(s.dispatches, []);
    assert.equal(s.store.state.receipts[ready].status, "pending");
  }
});

test("an untrusted scheduled event cannot advance pending work", async () => {
  const s = scheduledWake(fixture());
  s.run.triggering_actor.id = 777;
  await assert.rejects(wake.handleWake(s), /identity mismatch/);
  assert.deepEqual(s.dispatches, []);
});

test("a scheduled check acknowledges an ambiguous dispatch only after finding its exact bot receiver", async () => {
  for (const actor of [
    { login: "github-actions[bot]", id: 41898282 },
    { login: "haideearus", id: 101267861 },
  ]) {
    const { context: receiverContext, receiver, receiptId, ...original } = await receiverSetup();
    original.store.state.receipts[receiptId].status = "intent";
    original.context = {
      ...receiverContext,
      workflowRef: receiverContext.workflowRef.replace("factory-automatic", "factory-wake"),
      runId: "801",
      actor: "haideearus",
      triggeringActor: "haideearus",
    };
    const s = scheduledWake(original);
    const scheduledRun = { ...s.run, id: 801 };
    s.run.event = "issues";
    Object.assign(receiver, {
      actor,
      triggering_actor: actor,
      created_at: new Date().toISOString(),
    });
    const oldApi = s.api.request.bind(s.api);
    s.api.request = async (method, route, data) => {
      if (/\/runs\/801\/attempts\/1$/.test(route)) return scheduledRun;
      if (route.includes("/workflows/factory-automatic.yml/runs?"))
        return { workflow_runs: [receiver] };
      return oldApi(method, route, data);
    };
    await wake.handleWake(s);
    assert.equal(s.dispatches.length, 1);
    const receipt = s.store.state.receipts[receiptId];
    assert.equal(receipt.status, actor.id === 41898282 ? "sent" : "intent");
    assert.equal(receipt.receiver, null);
  }
});

async function dependencyPreparationFixture(event = "workflow_dispatch") {
  const s = fixture();
  const p = require("../factory/policy.cjs");
  const d = require("../factory/dependency-contract.cjs");
  const { claimDependency, finishPreparation } = require("../factory/dependency-policy.cjs");
  const { verifyWake } = require("../factory/trusted-wake.cjs");
  const fixtures = require("./helpers/factory-fixtures.cjs");
  const config = p.readConfig({
    ...fixtures.vars,
    ...s.vars,
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
    FACTORY_GITHUB_APP_SLUG: "factory-example",
  });
  s.context.event = s.run.event = "workflow_run";
  const fromWake = event === "workflow_dispatch";
  const sourceReceipt = fromWake ? queueNativeCI(s, 268, 702) : null;
  const actor = fromWake ? { login: "github-actions[bot]", id: 41898282 } : s.run.actor;
  const run = {
    ...s.run,
    id: 850,
    workflow_id: 85,
    path: ".github/workflows/factory-dependencies.yml",
    actor,
    triggering_actor: actor,
    event,
    display_title: fromWake
      ? `Dependency maintenance / wake ${sourceReceipt}`
      : "Dependency maintenance",
  };
  const request = s.api.request;
  s.api.request = async (method, path, body) => {
    if (method === "GET" && path.endsWith("/actions/runs/850/attempts/1"))
      return structuredClone(run);
    if (method === "GET" && path.endsWith("/actions/workflows/factory-dependencies.yml"))
      return { id: 85, path: run.path };
    if (method === "GET" && path.endsWith("/pulls/268") && !fromWake) {
      const repo = { full_name: s.context.repository };
      return {
        number: 268,
        state: "open",
        draft: false,
        user: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
        head: { sha: "d".repeat(40), ref: "dependabot/npm_and_yarn/demo-268", repo },
        base: { sha: s.context.workflowSha, ref: "main", repo },
      };
    }
    return request(method, path, body);
  };
  const context = {
    ...fixtures.context,
    actor: actor.login,
    triggeringActor: actor.login,
    workflowRef: d.WORKFLOW,
    workflowSha: run.head_sha,
    runId: "850",
    event,
  };
  if (fromWake) {
    s.store.state.receipts[sourceReceipt].status = "sent";
    context.wake = await verifyWake({
      ...s,
      context,
      receiptId: sourceReceipt,
      lane: "dependency",
      bind: true,
    });
  }
  const pr = await s.api.request("GET", "/pulls/268");
  const active = claimDependency(p.emptyState(s.context.repository), pr, context, config);
  s.ledger.state = finishPreparation(active, 268, context);
  run.status = "completed";
  run.conclusion = "failure";
  s.event = { repository: run.repository, action: "completed", workflow_run: run };
  return { ...s, run, sourceReceipt, active };
}

test("a released metadata-only dependency receiver hands off exactly one verified pending CI", async () => {
  const s = await dependencyPreparationFixture();
  const stale = queueNativeCI(s, 221, 703, "old-base");
  const sameHead = queueNativeCI(s, 268, 705);
  const first = queueNativeCI(s, 233, 706);
  const second = queueNativeCI(s, 258, 707);
  const before = structuredClone(s.ledger.state);

  const outcomes = await Promise.all([wake.handleWake(s), wake.handleWake(s)]);
  assert.deepEqual(outcomes.map((result) => result.outcome).sort(), ["dispatched", "duplicate"]);
  assert.equal(outcomes.find((result) => result.outcome === "dispatched").receiptId, first);
  assert.deepEqual(s.dispatches, [{ ref: "main", inputs: { wake_id: first, preview: false } }]);
  assert.equal(s.store.state.receipts[stale].status, "observed");
  assert.equal(s.store.state.receipts[sameHead].status, "observed");
  assert.equal(s.store.state.receipts[second].status, "pending");
  assert.deepEqual(s.ledger.state, before);
});

test("a scheduled owner preparation can hand off to pending dependency CI", async () => {
  const s = await dependencyPreparationFixture("schedule");
  const ready = queueNativeCI(s, 233, 706);
  assert.equal((await wake.handleWake(s)).receiptId, ready);
  assert.equal(s.dispatches.length, 1);
});

test("a model-free dependency gate recovery wakes one pending ticket only after safe release", async () => {
  for (const outcome of ["held", "merged", "unconfirmed", "unverified-merge"]) {
    const s = await dependencyPreparationFixture("schedule");
    const ready = queueNativeCI(s, 233, 706);
    const head = "e".repeat(40);
    const mergeCommit = "f".repeat(40);
    const reviewGrant = "same-reviewed-grant";
    const release =
      outcome === "held"
        ? null
        : {
            status: outcome === "unconfirmed" ? "intent" : "merged",
            pr: 299,
            head,
            runId: "850",
            runAttempt: 1,
            mergeCommit,
          };
    const failure = {
      stage: "required-checks",
      reason: "Current trusted review gate unavailable after refresh",
    };
    s.ledger.state.tickets = {
      299: {
        origin: "dependency-pr",
        pr: 299,
        head,
        branch: "dependabot/npm_and_yarn/demo-299",
        status: "reviewed",
        approval: {
          head,
          grant: reviewGrant,
          verdict: "pass",
          source: "claude-subscription",
          fixture: false,
        },
        dependency: { attempts: [{ head }], appSlug: "fixture-factory" },
        dependencyMergeRetry: {
          head,
          grant: reviewGrant,
          failure,
          phase: outcome === "held" ? "held" : "retrying",
          run: {
            runId: "850",
            runAttempt: 1,
            workflowSha: s.run.head_sha,
            at: "2026-11-27T21:07:41.000Z",
          },
        },
        ...(release ? { merge: release } : {}),
      },
    };
    s.ledger.state.grants[reviewGrant] = {
      head,
      phase: "review",
      ticket: 299,
      status: "finished",
      outcome: "reviewed",
      runId: "810",
      runAttempt: 1,
    };
    const audit = { ticket: 299, runId: "850", head };
    s.ledger.state.audit = [
      { ...audit, event: "dependency_merge_retry_claimed" },
      ...(outcome === "held"
        ? [{ ...audit, event: "dependency_merge_preflight_held", recovery: "held", failure }]
        : []),
    ];
    const request = s.api.request.bind(s.api);
    s.api.request = (method, route, data) => {
      if (route.endsWith("/pulls/299")) {
        const repo = s.run.repository;
        return {
          number: 299,
          state: ["merged", "unverified-merge"].includes(outcome) ? "closed" : "open",
          merged: ["merged", "unverified-merge"].includes(outcome),
          merge_commit_sha: outcome === "merged" ? mergeCommit : null,
          draft: false,
          user: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
          head: { ref: "dependabot/npm_and_yarn/demo-299", sha: head, repo },
          base: { ref: "main", sha: s.run.head_sha, repo },
        };
      }
      return request(method, route, data);
    };
    const result = await wake.handleWake(s);
    if (["unconfirmed", "unverified-merge"].includes(outcome)) {
      assert.equal(result.outcome, "ignored");
      assert.deepEqual(s.dispatches, []);
      assert.equal(s.store.state.receipts[ready].status, "pending");
    } else {
      assert.equal(result.outcome, "dispatched");
      assert.deepEqual(s.dispatches, [{ ref: "main", inputs: { wake_id: ready, preview: false } }]);
      assert.ok(
        Object.values(s.store.state.receipts).some(
          (entry) =>
            entry.signal.revision === "gate-recovery-release" && entry.status === "observed"
        )
      );
      assert.equal((await wake.handleWake(s)).outcome, "duplicate");
    }
  }
});

test("a rebase after lease release preserves the bound receiver's completion provenance", async () => {
  const s = await dependencyPreparationFixture();
  queueNativeCI(s, 268, 705, "stale");
  const ready = queueNativeCI(s, 233, 706);
  assert.equal((await wake.handleWake(s)).receiptId, ready);
  assert.equal(s.dispatches.length, 1);
});

test("released dependency preparation with no eligible CI dispatches nothing", async () => {
  const s = await dependencyPreparationFixture();
  const stale = queueNativeCI(s, 221, 703, "stale");
  const app = fixture();
  app.store = s.store;
  app.ledger.state.active = { ticket: 268, runId: "850", runAttempt: 1 };
  const pending = await wake.handleWake(app);
  const completion = await wake.handleWake(s);
  assert.equal(completion.outcome, "observed");
  const marker = s.store.state.receipts[completion.receiptId];
  assert.equal(marker.signal.kind, "drain");
  assert.throws(
    () => require("../factory/wake-contract.cjs").validateReceipt({ ...marker, status: "sent" }),
    /Invalid wake receipt/
  );
  assert.equal((await wake.handleWake(s)).outcome, "duplicate");
  assert.equal(s.store.state.receipts[stale].status, "observed");
  assert.equal(s.store.state.receipts[pending.receiptId].status, "pending");
  assert.deepEqual(s.dispatches, []);
});

test("dependency completion needs a released attempt and exact trusted receiver", async (t) => {
  for (const [label, change, rejection] of [
    ["no durable preparation", (s) => (s.ledger.state.tickets = {})],
    ["no recorded release", (s) => (s.ledger.state.audit = [])],
    ["lease still held", (s) => (s.ledger.state = s.active)],
    [
      "receipt never bound",
      (s) => {
        const receipt = s.store.state.receipts[s.sourceReceipt];
        receipt.receiver = null;
        receipt.status = "sent";
      },
    ],
    [
      "bound to another run",
      (s) => (s.store.state.receipts[s.sourceReceipt].receiver.runId = "851"),
    ],
    ["wrong receiver title", (s) => (s.run.display_title = "Dependency maintenance")],
    [
      "wrong triggering actor",
      (s) => (s.run.triggering_actor = { login: "haideearus", id: 101267861 }),
    ],
    [
      "wrong receiver actor ID",
      (s) => (s.run.actor = { ...s.run.actor, id: 1 }),
      /Wake receiver identity changed/,
    ],
    ["different workflow revision", (s) => (s.run.head_sha = "f".repeat(40))],
    ["not terminal", (s) => (s.run.status = "in_progress"), /Untrusted source workflow run/],
  ]) {
    await t.test(label, async () => {
      const s = await dependencyPreparationFixture();
      const ready = queueNativeCI(s, 233, 706);
      change(s);
      if (rejection) await assert.rejects(wake.handleWake(s), rejection);
      else assert.equal((await wake.handleWake(s)).outcome, "ignored");
      assert.equal(s.store.state.receipts[ready].status, "pending");
      assert.deepEqual(s.dispatches, []);
    });
  }
});

test("a stopped factory leaves dependency CI pending after preparation releases", async () => {
  const s = await dependencyPreparationFixture();
  const ready = queueNativeCI(s, 233, 706);
  s.ledger.state.stop = { reason: "Owner stop" };
  assert.equal((await wake.handleWake(s)).outcome, "stopped");
  assert.equal(s.store.state.receipts[ready].status, "pending");
  assert.deepEqual(s.dispatches, []);
});

test("discovery completion skips stale CI and binds the next dependency PR exactly once", async () => {
  const s = await discoveryDrainFixture();
  const stale = [220, 221, 222, 223, 224, 226].map((number) =>
    queueNativeCI(s, number, 600 + number, "stale")
  );
  const unavailable = queueNativeCI(s, 233, 702, "unavailable");
  const ready = queueNativeCI(s, 236, 703);
  const before = structuredClone(s.ledger.state);
  const result = await wake.handleWake(s);
  assert.equal(result.receiptId, ready);
  assert.ok(stale.every((id) => s.store.state.receipts[id].status === "observed"));
  assert.equal(s.store.state.receipts[unavailable].status, "pending");
  assert.equal(result.skipped.length, 7);
  assert.deepEqual(result.skipped.at(-1), {
    kind: "dependency-ci",
    number: 233,
    reason: "Wake evidence could not be verified",
  });
  assert.deepEqual(s.dispatches, [{ ref: "main", inputs: { wake_id: ready, preview: false } }]);

  const context = {
    ...s.context,
    actor: "github-actions[bot]",
    triggeringActor: "github-actions[bot]",
    event: "workflow_dispatch",
    workflowRef: s.context.workflowRef.replace("factory-wake", "factory-dependencies"),
    runId: "900",
  };
  const actor = { login: context.actor, id: 41898282 };
  const path = ".github/workflows/factory-dependencies.yml";
  const request = s.api.request;
  s.api.request = (method, href, body) =>
    href.endsWith("/actions/runs/900/attempts/1")
      ? Promise.resolve({
          ...s.run,
          id: 900,
          workflow_id: 90,
          path,
          actor,
          triggering_actor: actor,
          event: "workflow_dispatch",
          display_title: `Dependency maintenance / wake ${ready}`,
        })
      : href.endsWith("/actions/workflows/factory-dependencies.yml")
        ? Promise.resolve({ id: 90, path })
        : request(method, href, body);
  const { verifyWake, dependencyWakeTarget } = require("../factory/trusted-wake.cjs");
  const proof = await verifyWake({
    ...s,
    context,
    receiptId: ready,
    lane: "dependency",
    bind: true,
  });
  const target = dependencyWakeTarget({ ...context, wake: proof });
  assert.equal(target.number, 236);
  assert.equal(target.head, "d".repeat(40));
  assert.equal(s.store.state.receipts[ready].signal.sourceRun, "703");
  assert.equal((await wake.handleWake(s)).outcome, "duplicate");
  assert.equal(s.dispatches.length, 1);
  assert.deepEqual(s.ledger.state, before);
});

test("discovery completion keeps its app route when no queued dependency CI is usable", async () => {
  const s = await discoveryDrainFixture();
  const stale = queueNativeCI(s, 221, 701, "old-base");
  const result = await wake.handleWake(s);
  assert.equal(result.lane, "app");
  assert.deepEqual(s.dispatches, [
    { ref: "main", inputs: { wake_id: result.receiptId, dry_run: false } },
  ]);
  const { signal } = s.store.state.receipts[result.receiptId];
  assert.equal(signal.kind, "drain");
  assert.equal(signal.sourceRun, "850");
  assert.equal(s.store.state.receipts[stale].status, "observed");
  await require("../factory/trusted-wake.cjs").verifySource(s.api, signal, false);
});

test("a later completion reaches dependency CI behind a full batch of unavailable sources", async () => {
  const s = await discoveryDrainFixture();
  const deferred = Array.from({ length: 20 }, (_, i) =>
    queueNativeCI(s, 200 + i, 700 + i, "unavailable")
  );
  const ready = queueNativeCI(s, 236, 750);
  const first = await wake.handleWake(s);
  assert.equal(first.lane, "app");
  assert.equal(s.store.state.receipts[ready].status, "pending");

  const next = await discoveryDrainFixture("851");
  const request = s.api.request;
  s.api.request = (method, path, body) =>
    path.endsWith("/actions/runs/851/attempts/1")
      ? next.api.request(method, path, body)
      : request(method, path, body);
  assert.equal(
    (await wake.handleWake({ ...s, event: next.event, ledger: next.ledger })).receiptId,
    ready
  );
  assert.ok(deferred.every((id) => s.store.state.receipts[id].status === "pending"));
  assert.equal(s.dispatches.length, 2);
});

test("an app completion still wakes the ordinary app queue for pending app work", async () => {
  const s = await discoveryDrainFixture();
  const pending = fixture();
  pending.store = s.store;
  pending.ledger.state.active = { ticket: 9, runId: "850", runAttempt: 1 };
  const { receiptId } = await wake.handleWake(pending);
  const result = await wake.handleWake(s);
  assert.equal(result.lane, "app");
  assert.equal(s.store.state.receipts[result.receiptId].signal.kind, "drain");
  assert.equal(s.store.state.receipts[receiptId].status, "observed");
});

test("unusable app work does not hide current dependency CI", async (t) => {
  for (const [label, change] of [
    ["closed", (s) => (s.issue.state = "closed")],
    ["already admitted", (s) => (s.ledger.state.tickets["12"] = { status: "blocked" })],
  ]) {
    await t.test(label, async () => {
      const s = await discoveryDrainFixture();
      const pending = fixture();
      pending.store = s.store;
      pending.ledger.state.active = { ticket: 9, runId: "850", runAttempt: 1 };
      const app = await wake.handleWake(pending);
      change(s);
      const dependency = queueNativeCI(s, 236, 703);
      assert.equal((await wake.handleWake(s)).receiptId, dependency);
      assert.equal(s.store.state.receipts[app.receiptId].status, "observed");
    });
  }
});

test("a completed Proactive discovery grant can wake and bind the ordinary app receiver", async () => {
  const s = await discoveryDrainFixture();
  const before = structuredClone(s.ledger.state);
  const result = await wake.handleWake(s);
  assert.equal(result.outcome, "dispatched");
  assert.equal(result.lane, "app");
  assert.equal(s.dispatches.length, 1);
  assert.equal(s.store.state.receipts[result.receiptId].signal.sourceRun, "850");
  const context = {
    ...s.context,
    actor: "github-actions[bot]",
    triggeringActor: "github-actions[bot]",
    event: "workflow_dispatch",
    workflowRef: s.context.workflowRef.replace("factory-wake", "factory-automatic"),
    runId: "900",
  };
  const receiver = {
    ...s.run,
    id: 900,
    workflow_id: 85,
    path: ".github/workflows/factory-automatic.yml",
    actor: { login: context.actor, id: 41898282 },
    triggering_actor: { login: context.actor, id: 41898282 },
    event: "workflow_dispatch",
    display_title: `Automatic factory / wake ${result.receiptId}`,
  };
  const base = s.api.request;
  s.api.request = (method, path, body) =>
    path.endsWith("/actions/runs/900/attempts/1")
      ? Promise.resolve(receiver)
      : base(method, path, body);
  const { verifyWake, isTrustedWakeContext } = require("../factory/trusted-wake.cjs");
  const proof = await verifyWake({
    ...s,
    context,
    receiptId: result.receiptId,
    lane: "app",
    bind: true,
  });
  assert.equal(isTrustedWakeContext({ ...context, wake: proof }, "app"), true);
  assert.equal(s.store.state.receipts[result.receiptId].receiver.runId, "900");
  assert.deepEqual(s.ledger.state, before);
});

test("a discovery drain cannot impersonate another workflow, actor, branch or repository", async () => {
  const p = require("../factory/policy.cjs");
  const { verifySource } = require("../factory/trusted-wake.cjs");
  for (const change of [
    (r) => Object.assign(r, { path: ".github/workflows/factory-automatic.yml" }),
    (r) => Object.assign(r, { head_repository: { full_name: "someone/other-app" } }),
    (r) => Object.assign(r, { triggering_actor: { login: p.OWNER, id: 101267861 } }),
    (r) => Object.assign(r, { head_branch: "off-main" }),
    (r) => Object.assign(r, { head_sha: "f".repeat(40) }),
    (r) => Object.assign(r, { status: "in_progress" }),
  ]) {
    const s = await discoveryDrainFixture();
    const signal = await wake.classifySignal(s);
    change(s.drainRun);
    await assert.rejects(verifySource(s.api, signal, false), /source workflow|drain source/i);
  }
});
