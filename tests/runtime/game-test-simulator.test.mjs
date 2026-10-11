import assert from 'node:assert/strict';
import test from 'node:test';
import {runGameTest} from '../../scripts/runtime/game-test-session.mjs';
import {createGameSimulator} from '../../scripts/runtime/game-test-simulator.mjs';
const udid='12345678-1234-1234-1234-123456789abc';
function fixture({state='Shutdown',ambiguous=false,badShutdown=false}={}) {
 const calls=[];const releases=[];let current=state;
 const run=async argv=>{
  calls.push(argv);
  if(argv[1]==='list')return JSON.stringify({devices:{runtime:[{udid,state:current,isAvailable:true},{udid:'87654321-1234-1234-1234-123456789abc',state:'Booted',isAvailable:true}]}});
  assert.equal(argv[2],udid);
  if(argv[1]==='boot'){current='Booted';if(ambiguous)throw new Error('lost boot response');}
  if(argv[1]==='shutdown'&&!badShutdown)current='Shutdown';
  return '';
 };
 const governor={acquireHostSlot:async({kind})=>({id:kind,heartbeat:async()=>{},release:async value=>releases.push(value)})};
 return {run,calls,releases,governor,get state(){return current;}};
}
test('pre-existing simulator and invalid identity cause no boot or shutdown',async()=>{
 for(const identity of [udid,'booted','all','--help']) {
  const f=fixture({state:'Booted'});
  await assert.rejects(runGameTest({projectRoot:process.cwd(),governor:f.governor,resourceKind:'emulator'},s=>createGameSimulator(s,identity,{run:f.run})),/simulator/);
  assert.equal(f.calls.some(v=>['boot','shutdown'].includes(v[1])),false);
 }
});
test('successful boot cleans only the exact owned UDID and verifies Shutdown',async()=>{
 const f=fixture();
 await runGameTest({projectRoot:process.cwd(),governor:f.governor,resourceKind:'emulator'},s=>createGameSimulator(s,udid,{run:f.run}));
 assert.equal(f.state,'Shutdown');assert.deepEqual(f.calls.filter(v=>v[1]==='shutdown'),[['simctl','shutdown',udid]]);
 assert.deepEqual(f.releases,[{quiescent:true},{quiescent:true}]);
});
test('ambiguous boot and unconfirmed shutdown quarantine instead of closing foreign devices',async()=>{
 for(const scenario of [{ambiguous:true},{badShutdown:true}]) {
  const f=fixture(scenario);
  await assert.rejects(runGameTest({projectRoot:process.cwd(),governor:f.governor,resourceKind:'emulator'},s=>createGameSimulator(s,udid,{run:f.run})),/cleanup/);
  assert.deepEqual(f.releases,[{quiescent:false},{quiescent:false}]);
  if(scenario.ambiguous)assert.equal(f.calls.some(v=>v[1]==='shutdown'),false);
 }
});
test('boot resolving during or after cancellation shuts down only the owned device without clearing prior quarantine',async()=>{
 for(const late of [false,true]) {
  const f=fixture(),controller=new AbortController();let resolveBoot,work,saved;
  const run=async argv=>{
   const value=await f.run(argv);
   if(argv[1]==='boot') {
    controller.abort(new Error('cancel boot'));
    if(late)await new Promise(resolve=>{resolveBoot=resolve;});
   }
   return value;
  };
  await assert.rejects(runGameTest({projectRoot:process.cwd(),governor:f.governor,resourceKind:'emulator',signal:controller.signal,cleanupMs:10},s=>{
   saved=s;work=createGameSimulator(s,udid,{run});return work;
  }),late?/cleanup_uncertain/:/cancel boot/);
  if(late){resolveBoot();await assert.rejects(work,/cancel boot/);}
  assert.equal(f.state,'Shutdown');
  assert.deepEqual(f.calls.filter(v=>v[1]==='shutdown'),[['simctl','shutdown',udid]]);
  assert.deepEqual(f.releases,[{quiescent:!late},{quiescent:!late}]);
  const count=f.calls.length;
  await assert.rejects(createGameSimulator(saved,udid,{run}),/session_closed/);
  assert.equal(f.calls.length,count);
 }
});
