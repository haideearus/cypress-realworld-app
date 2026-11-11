const test=require('node:test');const assert=require('node:assert/strict');
const {readConfig}=require('../factory/policy.cjs');const {GitHub,Ledger}=require('../factory/github.cjs');
const {vars,context,FactoryFixture}=require('./helpers/factory-fixtures.cjs');
let implementation;try{implementation=require('../factory/controller.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
async function setup(overrides={}){
  const fixture=new FactoryFixture();const api=new GitHub({token:'fixture-only',fetch:fixture.fetch});const ledger=new Ledger(api);await ledger.initialize();
  const controller=new implementation.Controller(api,readConfig({...vars,...overrides}),context,{sleep:async()=>{},maxPolls:2});
  return {fixture,api,ledger,controller};
}
function bundle(grant){return {kind:'code',grantId:grant.grantId,base:grant.head,
  files:[{path:'src/example.ts',mode:'100644',content:'export const fixed = true;\n'}],evidence:'Failing regression before; passing regression after.'};}
test('trusted controller exists',()=>assert.ok(implementation,'missing trusted controller'));
test('disabled admission never reserves usage or writes a patch',async()=>{
  const {controller,ledger,fixture}=await setup({FACTORY_ENABLED:'false'});
  assert.equal((await controller.admit(10)).ready,false);
  assert.equal((await ledger.read()).state.active,null);assert.equal(fixture.prs.length,0);
});
test('fixture ticket progresses through coding publication CI and a fresh review',async()=>{
  const {controller,ledger,fixture}=await setup();const grant=await controller.admit(10);
  const published=await controller.publish(grant.grantId,bundle(grant));
  assert.equal(published.pr,20);assert.equal(fixture.prs.length,1);
  const ci=await controller.ci(10);assert.equal(ci.passed,true);
  const review=await controller.reserveReview(10,ci.runId,'cycle1');
  assert.notEqual(review.grantId,grant.grantId);
  const result=await controller.assess(10,{coding:'success',publication:'success',ci:'success',review:'success'},ci.runId,review.grantId,
    {kind:'review',grantId:review.grantId,base:published.head,result:{head:published.head,verdict:'pass',summary:'No blocking findings',findings:[]}},'cycle1');
  assert.equal(result.retry,false);assert.equal((await ledger.read()).state.tickets['10'].status,'reviewed');
  assert.equal(fixture.checks.at(-1).conclusion,'success');assert.equal(fixture.checks.at(-1).head_sha,published.head);
});
test('forbidden patch consumes its attempt but creates no PR or privileged execution',async()=>{
  const {controller,fixture,ledger}=await setup();const grant=await controller.admit(10);const input=bundle(grant);
  input.files[0].path='.github/workflows/factory-agents.yml';
  await assert.rejects(controller.publish(grant.grantId,input),/path|policy/i);
  assert.equal(fixture.prs.length,0);assert.equal((await ledger.read()).state.tickets['10'].coding,1);
});
test('CI failure permits only the single remaining coding attempt',async()=>{
  const {controller,fixture,ledger}=await setup();fixture.ciConclusion='failure';const g=await controller.admit(10);
  await controller.publish(g.grantId,bundle(g));const ci=await controller.ci(10);assert.equal(ci.passed,false);
  const retry=await controller.assess(10,{coding:'success',publication:'success',ci:'success',review:'skipped'},ci.runId,'',null,'cycle1');
  assert.equal(retry.retry,true);assert.equal((await ledger.read()).state.tickets['10'].coding,2);
  const state=(await ledger.read()).state;assert.equal(state.tickets['10'].retries,1);
});
test('a failed model job is blocked without retrying a possible subscription quota error',async()=>{
  const {controller,ledger}=await setup();await controller.admit(10);
  const result=await controller.assess(10,{coding:'failure',publication:'skipped',ci:'skipped',review:'skipped'},0,'',null,'cycle1');
  assert.equal(result.retry,false);const {state}=await ledger.read();assert.equal(state.active,null);assert.equal(state.tickets['10'].coding,1);
});
test('stale PR head cannot reserve or publish a passing review',async()=>{
  const {controller,fixture}=await setup();const g=await controller.admit(10);await controller.publish(g.grantId,bundle(g));
  const ci=await controller.ci(10);fixture.prHeadOverride='c'.repeat(40);
  await assert.rejects(controller.reserveReview(10,ci.runId,'cycle1'),/head/i);
  await controller.gate(20);assert.equal(fixture.checks.at(-1).conclusion,'failure');
});
test('cancellation releases only completed prior runs and preserves consumed counters',async()=>{
  const {controller,api,ledger,fixture}=await setup();await controller.admit(10);fixture.activeRunStatus='in_progress';
  const recovery=new implementation.Controller(api,readConfig({...vars,FACTORY_ENABLED:'false'}),{...context,runId:'101'},{sleep:async()=>{},maxPolls:2});
  await recovery.cancel();const {state}=await ledger.read();assert.equal(state.active,null);assert.equal(state.tickets['10'].coding,1);
});
