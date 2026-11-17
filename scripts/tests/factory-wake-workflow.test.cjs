const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const yaml=require("js-yaml");
const {fixture,sha}=require("./helpers/event-fixtures.cjs");
const {classifySignal,handleWake}=require("../factory/wake-controller.cjs");
const load=n=>yaml.load(fs.readFileSync(`${__dirname}/../../.github/workflows/${n}.yml`,"utf8"));
test("wake observer is main-only, metadata-only and cannot observe itself or notification comments",()=>{
 const w=load("factory-wake");
 assert.deepEqual(w.on.issues.types,["opened","labeled","reopened","edited"]);
 assert.deepEqual(w.on.workflow_run.types,["completed"]);
 assert.equal(w.on.workflow_run.workflows.includes("Factory event wake"),false);
 assert.equal(w.on.workflow_run.workflows.includes("Factory activity"),false);
 assert.equal(w.on.issue_comment,undefined);
 assert.equal(w.on.workflow_dispatch.inputs.preview.default,true);
 const j=w.jobs.wake;assert.ok(j.if.includes("FACTORY_EVENT_PICKUP_ENABLED"));
 assert.deepEqual(j.permissions,{contents:"write",actions:"write",issues:"read","pull-requests":"read"});
 const checkout=j.steps.find(s=>s.uses?.startsWith("actions/checkout@"));
 assert.equal(checkout.with.ref,"${{ github.workflow_sha }}");
 assert.equal(checkout.with["persist-credentials"],false);
 assert.equal(JSON.stringify(w).includes("secrets."),false);
});
test("receivers expose a typed wake id and retain read-only previews",()=>{
 for(const [file,preview] of [["factory-automatic","dry_run"],["factory-dependencies","preview"]]) {
  const w=load(file);assert.equal(w.on.workflow_dispatch.inputs.wake_id.type,"string");
  assert.equal(w.on.workflow_dispatch.inputs.wake_id.default,"");
  assert.equal(w.on.workflow_dispatch.inputs[preview].default,true);
  assert.ok(w["run-name"].includes("inputs.wake_id"));
 }
});
test("idle completions, observer completions and owner harness CI cannot drain",async()=>{
 for(const path of [".github/workflows/factory-automatic.yml",".github/workflows/factory-wake.yml",".github/workflows/factory-activity.yml",".github/workflows/factory-ci.yml"]) {
  const s=fixture();s.context.event="workflow_run";s.event={repository:{full_name:s.context.repository},action:"completed",workflow_run:{id:700,run_attempt:1,path}};
  const base=s.api.request;s.api.request=async(m,p,b)=>p.includes("/runs/700/")?{...s.run,id:700,path,workflow_id:70,event:"workflow_dispatch",status:"completed",conclusion:"success"}:p.includes("/actions/workflows/")?{id:70,path}:base(m,p,b);
  assert.equal(await classifySignal(s),null);
 }
});
test("successful exact-head native Dependabot CI selects the dependency lane; failed or stale CI cannot",async()=>{
 for(const mode of ["ok","failed","stale","fork"]) {
  const s=fixture();s.context.event="workflow_run";
  s.event={repository:{full_name:s.context.repository},action:"completed",workflow_run:{id:700,run_attempt:1,path:".github/workflows/factory-ci.yml"}};
  const pr={number:22,state:"open",draft:false,user:{login:"dependabot[bot]",type:"Bot",id:49699333},head:{sha,ref:"dependabot/npm_and_yarn/demo-1.0.1",repo:{full_name:mode==="fork"?"evil/fork":s.context.repository}},base:{sha,ref:"main",repo:{full_name:s.context.repository}}};
  const base=s.api.request;
  s.api.pages=async()=>[{name:"verify",status:"completed",conclusion:"success"}];
  s.api.request=async(m,p,b)=>p.includes("/runs/700/")?{...s.run,id:700,path:".github/workflows/factory-ci.yml",workflow_id:70,head_sha:mode==="stale"?"b".repeat(40):sha,event:"pull_request",status:"completed",conclusion:mode==="failed"?"failure":"success",pull_requests:[{number:22}]}:p.endsWith("/actions/workflows/factory-ci.yml")?{id:70,path:".github/workflows/factory-ci.yml"}:p.endsWith("/pulls/22")?pr:p.includes("/pulls/22/files")?[{filename:"yarn.lock",status:"modified"}]:base(m,p,b);
  if(mode==="failed")await assert.rejects(classifySignal(s));else assert.equal((await classifySignal(s))?.lane||null,mode==="ok"?"dependency":null);
 }
});
test("completion drains a queued signal in the opposite lane exactly once, not another idle run",async()=>{
 const s=fixture();s.ledger.state.active={ticket:9,runId:"9",runAttempt:1};
 await handleWake(s);
 s.ledger.state.active=null;s.ledger.state.grants={used:{id:"used",ticket:9,runId:"700",runAttempt:1,status:"finished"}};
 s.context.event="workflow_run";s.run.event="workflow_run";
 s.event={repository:{full_name:s.context.repository},action:"completed",workflow_run:{id:700,run_attempt:1,path:".github/workflows/factory-dependencies.yml"}};
 const base=s.api.request;s.api.request=async(m,p,b)=>p.includes("/runs/700/")?{...s.run,id:700,workflow_id:70,path:".github/workflows/factory-dependencies.yml",status:"completed",conclusion:"success"}:p.endsWith("/actions/workflows/factory-dependencies.yml")?{id:70,path:".github/workflows/factory-dependencies.yml"}:base(m,p,b);
 const r=await handleWake(s);assert.equal(r.lane,"app");assert.equal(s.dispatches.length,1);
 assert.equal((await handleWake(s)).outcome,"duplicate");assert.equal(s.dispatches.length,1);
});
