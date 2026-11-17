const {createHash}=require("node:crypto");
const repository="haideearus/cypress-realworld-app",sha="a".repeat(40);
class MemoryStore {
  constructor(state){this.state=structuredClone(state);this.writes=0;this.queue=Promise.resolve();}
  async read(){return {state:structuredClone(this.state),commit:"b".repeat(40)};}
  async update(fn){const op=this.queue.then(async()=>{const next=await fn(structuredClone(this.state));this.state=next.state;this.writes++;return next;});this.queue=op.catch(()=>{});return op;}
}
function fixture(){
  const s={vars:{FACTORY_EVENT_PICKUP_ENABLED:"true",FACTORY_ENABLED:"true",FACTORY_AUTOMATION_ENABLED:"true",FACTORY_MAX_CONCURRENT_TICKETS:"1"},preview:false,dispatches:[]};
  s.issue={number:12,title:"Repair a real app bug",body:"Add a regression test before the repair",state:"open",user:{login:"haideearus",id:101267861},labels:[{name:"factory-ready"}],created_at:"2026-11-17T10:00:00Z",updated_at:"2026-11-17T10:00:00Z"};
  s.context={repository,actor:"haideearus",triggeringActor:"haideearus",ref:"refs/heads/main",event:"issues",workflowRef:repository+"/.github/workflows/factory-wake.yml@refs/heads/main",workflowSha:sha,runId:"800",runAttempt:1};
  s.event={action:"labeled",issue:{number:12},repository:{full_name:repository},sender:{login:"haideearus",id:101267861}};
  s.store=new MemoryStore({version:1,repository,receipts:{}});
  s.ledger=new MemoryStore({version:1,repository,active:null,days:{},tickets:{},grants:{},audit:[]});
  s.run={id:800,workflow_id:80,path:".github/workflows/factory-wake.yml",head_sha:sha,head_branch:"main",repository:{full_name:repository},head_repository:{full_name:repository},actor:{login:"haideearus",id:101267861},triggering_actor:{login:"haideearus",id:101267861},run_attempt:1,event:"issues",status:"in_progress",conclusion:null};
  s.api={async request(method,path,body){
    if(method==="GET"&&path.endsWith("/issues/12"))return structuredClone(s.issue);
    if(method==="GET"&&path.includes("/actions/workflows/"))return {id:80,path:".github/workflows/factory-wake.yml",state:"active"};
    if(method==="GET"&&/\/actions\/runs\/800(?:\/attempts\/1)?$/.test(path))return structuredClone(s.run);
    if(method==="GET"&&path.endsWith("/git/ref/heads/main"))return {object:{sha}};
    if(method==="POST"&&path.endsWith("/dispatches")){s.intentAtDispatch=structuredClone(Object.values(s.store.state.receipts)[0]);s.dispatches.push(body);if(s.uncertain)throw Error("transport uncertainty");return null;}
    throw Error("Unexpected fixture request "+method+" "+path);
  }};
  return s;
}
module.exports={fixture,MemoryStore,repository,sha,digest:v=>createHash("sha256").update(JSON.stringify(v)).digest("hex")};
