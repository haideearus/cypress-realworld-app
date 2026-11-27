const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { Ledger } = require("../factory/github.cjs");
const { verifyFunctionalChecks } = require("../factory/functional-browser.cjs");
const { publishFunctional } = require("../factory/functional-discovery.cjs");
const { AutomaticCoordinator } = require("../factory/automation.cjs");
const { AutomaticMerger } = require("../factory/merge.cjs");
const { handleWake } = require("../factory/wake-controller.cjs");
const { verifyWake, allowedModelBots } = require("../factory/trusted-wake.cjs");
const { BOT, BOT_ID } = require("../factory/wake-contract.cjs");
const { fixture: wakeFixture } = require("./helpers/event-fixtures.cjs");
const { vars, context, head, reviewFeedback } = require("./helpers/factory-fixtures.cjs");
const { m2Fixture, owner, mergeSha, repo } = require("./helpers/m2-github-fixture.cjs");

async function deliver(parentId, receiverId, workflowSha, revision, api, ledger, receivers) {
  const wake = wakeFixture();
  wake.ledger = ledger;
  wake.context.event = wake.run.event = "workflow_run";
  wake.context.workflowSha = wake.run.head_sha = workflowSha;
  const source = await api.request("GET", `/repos/${policy.REPOSITORY}/actions/runs/${parentId}/attempts/1`);
  wake.context.actor = wake.run.actor.login = source.actor.login;
  wake.run.actor.id = source.actor.id;
  wake.context.triggeringActor = wake.run.triggering_actor.login = source.actor.login;
  wake.run.triggering_actor.id = source.actor.id;
  wake.event = { action: "completed", repository: repo, workflow_run: source };
  const wakeRequest = wake.api.request;
  wake.api.request = (method,path,body) =>
    path.endsWith("/actions/workflows/factory-automatic.yml") ||
    path.endsWith(`/actions/runs/${parentId}/attempts/1`) ||
    path.endsWith(`/actions/runs/${receiverId}/attempts/1`) ||
    path.endsWith("/pulls/20") || path.includes("/git/ref/heads/factory/state") ||
    path.includes("/contents/state.json") ? api.request(method,path,body) : wakeRequest(method,path,body);
  wake.api.pages = async () => [];
  const { outcome, receiptId } = await handleWake(wake);
  assert.equal(outcome, "dispatched");
  assert.equal(wake.dispatches.length,1);
  assert.equal(wake.store.state.receipts[receiptId].signal.revision,revision);
  const bot = { login:BOT, id:BOT_ID };
  receivers.set(receiverId, {
    ...source, id:receiverId, event:"workflow_dispatch", head_sha:workflowSha, actor:bot,
    triggering_actor:bot, status:"in_progress", conclusion:null,
    display_title:`Automatic factory / wake ${receiptId}`,
  });
  const receiverContext = {
    ...context, runId:String(receiverId), workflowRef:policy.AUTOMATIC_WORKFLOW_REF,
    workflowSha, actor:BOT, triggeringActor:BOT, event:"workflow_dispatch",
  };
  async function bind() {
    return verifyWake({ ...wake, context:receiverContext, receiptId, bind:true, lane:"app" });
  }
  receiverContext.wake = await bind();
  return { receiverContext, bind };
}

// Model-free integration. GitHub API responses, Cypress results and both model outputs are
// fixtures. Ticket publication, admission, reservations, recovery, assessment, protected
// merge and the subsequent dispatch decision run through the production controllers.
test("one Settings incident resumes its own PR within budget and hands off after confirmed merge", async () => {
  const { api, monitor, calls, gh, comments, receivers } = m2Fixture();
  const config = policy.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_AUTOMERGE_ENABLED: "true",
    FACTORY_EVENT_PICKUP_ENABLED: "true",
    FACTORY_GITHUB_APP_SLUG: "fixture-factory",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123",
    FACTORY_MAX_AI_SESSIONS_PER_TICKET: "3",
  });
  const ledger = new Ledger(api);
  await ledger.initialize();
  const discovery = {
    repository: policy.REPOSITORY,
    actor: policy.OWNER,
    triggeringActor: policy.OWNER,
    ref: "refs/heads/main",
    workflowSha: head,
    sha: head,
    runAttempt: 1,
    eventName: "schedule",
    workflowRef: `${policy.REPOSITORY}/.github/workflows/factory-functional-discovery.yml@refs/heads/main`,
  };
  for (const [runId, expected] of [
    ["514", "incident_created"],
    ["515", "incident_existing"],
  ]) {
    let checks = 0;
    const observed = await verifyFunctionalChecks(async () => {
      checks++;
      return { status: "failed", failures: { "form-validation": "settings-email-invalid" } };
    });
    assert.equal(checks, 2);
    const result = await publishFunctional({
      api,
      store: monitor,
      ...observed,
      enabled: true,
      dryRun: false,
      context: { ...discovery, runId },
    });
    assert.equal(result.outcome, expected);
    assert.equal(result.issue, 10);
  }
  assert.equal(gh.issues.size, 1);
  assert.equal(comments.length, 1);
  const parent = (runId, workflowSha = head) => ({
    ...context,
    event: "schedule",
    workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
    workflowSha,
    runId,
  });
  const first = new AutomaticCoordinator(api, config, parent("700"));
  const code = await first.pick();
  assert.equal(code.ticket, 10);
  const pr = await first.controller.publish(code.grantId, {
    kind: "code",
    grantId: code.grantId,
    base: code.head,
    files: [
      {
        path: "src/components/UserSettingsForm.tsx",
        mode: "100644",
        content: "export const validEmail = true;\n",
      },
    ],
    evidence: "Fixture RED and GREEN for the synthetic Settings validation result.",
  });
  assert.equal(pr.pr, 20);
  const ci = await first.controller.ci(10);
  const interrupted = await first.controller.reserveReview(10, ci.runId, "cycle1");
  gh.issues.set(11, {
    number: 11,
    state: "open",
    title: "Repair next Settings defect",
    body: "Verify the next repair.",
    user: owner,
    labels: [{ name: "factory-ready" }],
    created_at: "2026-11-21T12:00:00Z",
  });
  const interruptedWake = await deliver(700,701,head,"app-interrupted",api,ledger,receivers);
  const recoveryContext = interruptedWake.receiverContext;
  const recovery = new AutomaticCoordinator(api, config, recoveryContext);
  const resumed = await recovery.pick();
  assert.equal(resumed.ticket, 10, JSON.stringify(resumed));
  assert.equal(resumed.reviewOnly, true);
  const freshCi = await recovery.controller.ci(10);
  const grant = await recovery.controller.reserveReview(10, freshCi.runId, "cycle1");
  assert.notEqual(grant.grantId, interrupted.grantId);
  // A separate model job has to rebind the same durable receipt and pass preflight.
  const workerContext = {
    ...recoveryContext, wake:await interruptedWake.bind(), ticket:10, head:pr.head, phase:"review", slot:"cycle1"
  };
  const beforeReview = (await ledger.read()).state;
  assert.equal(policy.preflight(beforeReview,grant.grantId,workerContext,config).id,grant.grantId);
  assert.equal(allowedModelBots(workerContext,beforeReview.tickets[10]),BOT);
  const review = await recovery.controller.assess(
    10,
    { coding: "skipped", publication: "skipped", ci: "success", review: "success" },
    freshCi.runId,
    grant.grantId,
    {
      kind: "review",
      grantId: grant.grantId,
      base: pr.head,
      result: JSON.parse(reviewFeedback(pr.head)),
    },
    "cycle1"
  );
  assert.equal(review.reviewed, true);
  const merger = new AutomaticMerger(api, config, recoveryContext, {
    sleep: async () => {},
    maxPolls: 1,
  });
  const merged = await merger.merge(10);
  assert.equal(merged.merged, true);
  const { state } = await ledger.read();
  assert.equal(state.grants[interrupted.grantId].outcome, "blocked");
  assert.equal(state.grants[code.grantId].outcome, "awaiting_review");
  assert.equal(state.tickets[10].coding + state.tickets[10].reviews, 3);
  assert.equal(state.tickets[10].aiSessionLimit, 3);
  assert.equal(gh.prs.length, 1);
  assert.equal(gh.issues.get(10).state, "open", "production verification can still be pending");
  assert.equal(
    calls.filter(({ method, path }) => method === "PUT" && path === "/pulls/20/merge").length,
    1
  );

  Object.assign(receivers.get(701), {status:"completed",conclusion:"success"});
  const {receiverContext} = await deliver(701,702,mergeSha,"app-merge",api,ledger,receivers);
  const next = new AutomaticCoordinator(api, config, receiverContext);
  const admitted = await next.pick();
  assert.equal(admitted.ticket,11);
  const after = (await ledger.read()).state;
  const codingContext = {...receiverContext, phase:"code", ticket:11, head:admitted.head, slot:"cycle1"};
  assert.equal(policy.preflight(after, admitted.grantId, codingContext, config).id, admitted.grantId);
  assert.equal(allowedModelBots(codingContext,after.tickets[11]), BOT);
  assert.equal(after.active.ticket, 11);
});
