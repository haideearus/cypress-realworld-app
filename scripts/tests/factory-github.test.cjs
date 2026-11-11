const test=require('node:test');const assert=require('node:assert/strict');
const {vars,context,GitHubFixture}=require('./helpers/factory-fixtures.cjs');
const policy=require('../factory/policy.cjs');
let adapter;try{adapter=require('../factory/github.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
function setup(){const fixture=new GitHubFixture();const api=new adapter.GitHub({token:'fixture-only',fetch:fixture.fetch});return {fixture,api,ledger:new adapter.Ledger(api)};}
test('GitHub persistence adapter exists',()=>assert.ok(adapter,'missing GitHub ledger adapter'));
test('missing state refuses reads and initialization is explicit and one-time',async()=>{
  const {ledger}=setup();await assert.rejects(ledger.read(),/GitHub.*404/);
  await ledger.initialize();const {state}=await ledger.read();assert.equal(state.version,1);assert.equal(state.active,null);
  await assert.rejects(ledger.initialize(),/already initialized/i);
});
test('GitHub requests cannot send the credential outside the fixed repository/origin',async()=>{
  const {api}=setup();
  for(const path of ['https://evil.invalid/collect','/user','/repos/another/repo/issues','//evil.invalid','/repos/haideearus/cypress-realworld-app/../other'])
    await assert.rejects(api.request('GET',path),/repository|path/i);
});
test('a committed reservation survives a new ledger instance',async()=>{
  const {ledger,api}=setup();await ledger.initialize();
  const saved=await ledger.update(state=>policy.reserve(state,context,policy.readConfig(vars),new Date('2026-11-11T12:00:00Z')));
  const fresh=await new adapter.Ledger(api).read();
  assert.equal(fresh.state.tickets['10'].coding,1);assert.equal(fresh.state.grants[saved.grant.id].status,'reserved');
  assert.equal(fresh.commit,saved.commit);
});
test('concurrent reservations cannot create two active tickets or lose a counter update',async()=>{
  const {ledger}=setup();await ledger.initialize();
  const outcomes=await Promise.allSettled([10,11].map(ticket=>ledger.update(state=>policy.reserve(state,{...context,ticket},policy.readConfig(vars)))));
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  const {state}=await ledger.read();assert.equal(Object.keys(state.tickets).length,1);
  assert.equal(Object.values(state.tickets)[0].coding,1);
});
test('failed writes do not grant permission or silently recreate state',async()=>{
  const {fixture,ledger}=setup();await ledger.initialize();fixture.failWrites=true;
  await assert.rejects(ledger.update(state=>policy.reserve(state,context,policy.readConfig(vars))),/503/);
  assert.equal((await ledger.read()).state.active,null);
});
test('corrupted JSON and unexpected file types fail closed',async()=>{
  const {api,ledger}=setup();await ledger.initialize();
  const bad=new adapter.GitHub({token:'fixture-only',fetch:async()=>new Response(JSON.stringify({type:'file',encoding:'base64',content:Buffer.from('not json').toString('base64')}),{status:200})});
  await assert.rejects(new adapter.Ledger(bad).read());
  const original=api.request.bind(api);api.request=async(method,path,body)=>path.includes('/contents/')?{type:'symlink'}:original(method,path,body);
  await assert.rejects(ledger.read(),/ledger/i);
});
