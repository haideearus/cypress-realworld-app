const fs = require("node:fs");
const c = require("./wake-contract.cjs");
const { ROOT } = require("./github.cjs");
const { WakeStore } = require("./wake-store.cjs");
// A JSON field is not authorization. Only this API-verifying module can mint a proof.
const proofs = new WeakMap();
function isTrustedWakeContext(context, lane) {
  const proof=context?.wake, binding=proof && proofs.get(proof);
  return Boolean(binding && (!lane || binding.lane===lane) && c.receiverIdentity(context,binding.lane) && binding.runId===context.runId && binding.workflowSha===context.workflowSha && binding.runAttempt===context.runAttempt);
}
async function verifySource(api, signal, bound) {
  const {criteriaHash}=require("./controller.cjs");
  const {eligibleIssue}=require("./automation.cjs");
  if(signal.kind==="issue" || signal.kind==="monitor") {
    const issue=await api.request("GET",`${ROOT}/issues/${signal.number}`);
    if(issue.state!=="open" || issue.pull_request || criteriaHash(issue)!==signal.criteriaHash)throw Error("Wake issue criteria changed");
    if(signal.kind==="issue" && (!eligibleIssue(issue) || issue.user?.id!==101267861 || issue.updated_at!==signal.revision))throw Error("Wake issue source changed");
    if(signal.kind==="monitor") {
      const proof=await require("./monitor-origin.cjs").verifyMonitorIssue(api,issue);
      if(!proof || proof.runId!==signal.sourceRun || proof.incidentId!==signal.revision)throw Error("Wake monitor receipt changed");
    }
    return;
  }
  const {verifiedRun}=require("./wake-controller.cjs");
  if(signal.kind==="dependency-ci") {
    const d=require("./dependency-contract.cjs");
    const pr=d.prOK(await api.request("GET",`${ROOT}/pulls/${signal.number}`),bound);
    if(pr.head.sha!==signal.head || d.criteria(pr.number)!==signal.criteriaHash)throw Error("Wake dependency head changed");
    if(!bound && pr.base.sha!==(await api.request("GET",`${ROOT}/git/ref/heads/main`)).object?.sha)throw Error("Wake dependency base stale");
    d.filesOK(await api.request("GET",`${ROOT}/pulls/${pr.number}/files?per_page=3`));
    const run=await verifiedRun(api,signal.sourceRun,signal.sourceAttempt,"factory-ci.yml");
    if(run.event!=="pull_request" || run.head_sha!==signal.head || !run.pull_requests?.some(p=>p.number===pr.number))throw Error("Wake CI source changed");
    const jobs=await api.pages(`${ROOT}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,"jobs");
    if(jobs.filter(j=>j.name==="verify"&&j.status==="completed"&&j.conclusion==="success").length!==1)throw Error("Wake native CI failed");
    return;
  }
  if(signal.kind!=="drain")throw Error("Unknown wake source");
  const {Ledger}=require("./github.cjs");
  const {state}=await new Ledger(api).read();
  const grants=Object.values(state.grants).filter(g=>g.runId===signal.sourceRun&&g.runAttempt===signal.sourceAttempt);
  if(!grants.length || grants.some(g=>g.status!=="finished") || c.digest(grants.map(g=>g.id).sort())!==signal.criteriaHash || require("./active-tickets.cjs").activeEntries(state).some(e=>e.runId===signal.sourceRun))throw Error("Wake drain reservation changed");
  const run=await api.request("GET",`${ROOT}/actions/runs/${signal.sourceRun}/attempts/${signal.sourceAttempt}`);
  if(run.status!=="completed" || !["factory-automatic.yml","factory-dependencies.yml","factory-agents.yml"].some(f=>run.path===`.github/workflows/${f}`))throw Error("Wake drain source changed");
}
async function verifyWake({api,context,receiptId,lane,bind=false,store=new WakeStore(api)}) {
  if(!c.HASH.test(receiptId || "") || !c.receiverIdentity(context,lane))throw Error("Untrusted wake receiver context");
  const {state}=await store.read();
  const receipt=state.receipts[receiptId];
  c.validateReceipt(receipt);
  if(receipt.signal.lane!==lane || receipt.status==="pending")throw Error("Wake dispatch intent missing");
  const {verifiedRun}=require("./wake-controller.cjs");
  const producer=await verifiedRun(api,receipt.producer.runId,1,"factory-wake.yml",{terminal:false});
  if(producer.head_branch!=="main" || producer.head_sha!==receipt.producer.workflowSha || producer.actor?.login!==receipt.producer.actor.login || producer.actor?.id!==receipt.producer.actor.id || producer.event!==receipt.producer.event)throw Error("Wake producer identity changed");
  const receiver=await verifiedRun(api,context.runId,1,c.LANES[lane],{terminal:false,success:false});
  if(receiver.event!=="workflow_dispatch" || receiver.head_branch!=="main" || receiver.head_sha!==context.workflowSha || receiver.actor?.login!==c.BOT || receiver.actor?.id!==c.BOT_ID || receiver.triggering_actor?.login!==c.BOT || receiver.triggering_actor?.id!==c.BOT_ID || receiver.display_title!==`${lane==="app"?"Automatic factory":"Dependency maintenance"} / wake ${receiptId}`)throw Error("Wake receiver identity changed");
  await verifySource(api,receipt.signal,receipt.receiver!==null);
  const expected={runId:context.runId,runAttempt:1,workflowSha:context.workflowSha};
  if(receipt.receiver && JSON.stringify(receipt.receiver)!==JSON.stringify(expected))throw Error("Wake already bound to another receiver");
  if(!receipt.receiver) {
    if(!bind)throw Error("Wake receiver has not been bound");
    await store.update(s=>{const r=c.validateReceipt(s.receipts[receiptId]);if(r.receiver && JSON.stringify(r.receiver)!==JSON.stringify(expected))throw Error("Wake already bound to another receiver");r.receiver=expected;r.status="bound";return {state:s};});
  }
  const proof=Object.freeze({receiptId,lane,actor:c.BOT,sourceActor:receipt.signal.actor.login,producerRun:receipt.producer.runId});
  proofs.set(proof,{...expected,lane});
  return proof;
}
async function loadWakeContext(api,context,env=process.env,{bind=false}={}) {
  if(context.actor!==c.BOT)return context;
  let receiptId;
  if(env.GITHUB_EVENT_PATH) {
    const stat=fs.lstatSync(env.GITHUB_EVENT_PATH);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>2000000)throw Error("Invalid GitHub event file");
    receiptId=JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH,"utf8")).inputs?.wake_id;
  }
  if(!receiptId) {
    const {state}=await new WakeStore(api).read();
    const rows=Object.values(state.receipts).filter(r=>r.receiver?.runId===context.runId&&r.receiver?.runAttempt===context.runAttempt);
    if(rows.length!==1)throw Error("Missing bound wake receipt");
    receiptId=rows[0].id;
  }
  const lane=Object.keys(c.LANES).find(k=>context.workflowRef===`${c.REPOSITORY}/.github/workflows/${c.LANES[k]}@refs/heads/main`);
  return {...context,wake:await verifyWake({api,context,receiptId,lane,bind})};
}
module.exports={isTrustedWakeContext,verifySource,verifyWake,loadWakeContext};
