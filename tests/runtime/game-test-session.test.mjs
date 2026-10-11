import assert from 'node:assert/strict';
import test from 'node:test';
import {runGameTest} from '../../scripts/runtime/game-test-session.mjs';

function governor({deny=false}={}) {
 const releases=[];
 return {releases,async acquireHostSlot({kind}) {
  if(deny) throw new Error('admission denied');
  return {id:kind,heartbeat:async()=>{},async release(value){releases.push({kind,...value});}};
 }};
}
test('admission denial prevents all resource effects',async()=>{
 let effects=0;
 await assert.rejects(runGameTest({projectRoot:process.cwd(),governor:governor({deny:true})},async()=>{effects++;}),/admission denied/);
 assert.equal(effects,0);
});
test('success and assertion failure both close owned resources before releasing capacity',async()=>{
 for(const fail of [false,true]) {
  const g=governor(); const live=new Set(['browser','server']);
  const run=runGameTest({projectRoot:process.cwd(),governor:g},async session=>{
   for(const name of live) await session.own({close:async()=>live.delete(name),isClosed:()=>!live.has(name)});
   if(fail) throw new Error('assertion failed');
   return 'checked';
  });
  if(fail) await assert.rejects(run,/assertion failed/);else assert.equal((await run).result,'checked');
  assert.equal(live.size,0);
  assert.deepEqual(g.releases,[{kind:'heavy',quiescent:true},{kind:'worker',quiescent:true}]);
 }
});
test('browser close failure still closes the server and quarantines both slots',async()=>{
 const g=governor();let serverClosed=false;
 await assert.rejects(runGameTest({projectRoot:process.cwd(),governor:g},async session=>{
  await session.own({close:async()=>{serverClosed=true;},isClosed:()=>serverClosed});
  await session.own({close:async()=>{throw new Error('browser close failed');},isClosed:()=>false});
 }),/cleanup/);
 assert.equal(serverClosed,true);
 assert.deepEqual(g.releases,[{kind:'heavy',quiescent:false},{kind:'worker',quiescent:false}]);
});
test('timeout cancels cooperative work, while unsettled effects quarantine capacity',async()=>{
 for(const cooperative of [true,false]) {
  const g=governor(); let closed=false;
  await assert.rejects(runGameTest({projectRoot:process.cwd(),governor:g,timeoutMs:30,cleanupMs:40},async session=>{
   await session.own({close:async()=>{closed=true;},isClosed:()=>closed});
   await new Promise(resolve=>{if(cooperative) session.signal.addEventListener('abort',resolve,{once:true});});
  }),/timeout/);
  assert.equal(closed,true);
  assert.equal(g.releases[0].quiescent,cooperative);
 }
});
