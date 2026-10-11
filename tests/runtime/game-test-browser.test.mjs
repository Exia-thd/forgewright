import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {runGameTest} from '../../scripts/runtime/game-test-session.mjs';
import {createGameBrowser} from '../../scripts/runtime/game-test-browser.mjs';

function fixture() {
 const context=new EventEmitter();let connected=true;let opens=0;const all=[];
 context.pages=()=>all.filter(p=>!p.isClosed());
 context.newPage=async()=>{
  await new Promise(r=>setTimeout(r,2));opens++;
  let closed=false;const page={isClosed:()=>closed,close:async()=>{closed=true;},opener:async()=>null};
  all.push(page);context.emit('page',page);return page;
 };
 context.close=async()=>{await Promise.all(all.map(p=>p.close()));};
 const type={launch:async()=>({newContext:async()=>context,close:async()=>{await context.close();connected=false;},isConnected:()=>connected})};
 const governor={acquireHostSlot:async({kind})=>({id:kind,heartbeat:async()=>{},release:async()=>{}})};
 return {context,type,governor,get opens(){return opens;},get connected(){return connected;}};
}
test('default requests reuse one page; simultaneous new requests reject before a third creation',async()=>{
 const f=fixture();
 await runGameTest({projectRoot:process.cwd(),governor:f.governor},async session=>{
  const b=await createGameBrowser(session,f.type);
  const [a,c]=await Promise.all([b.page(),b.page()]);assert.equal(a,c);assert.equal(f.opens,1);
  const values=await Promise.allSettled([b.newPage(),b.newPage()]);
  assert.equal(values.filter(v=>v.status==='fulfilled').length,1);
  assert.match(values.find(v=>v.status==='rejected').reason.message,/budget/);
  assert.equal(f.opens,2);
  let foreignClosed=false;
  await assert.rejects(b.closePage({close:async()=>{foreignClosed=true;}}),/foreign/);
  assert.equal(foreignClosed,false);
 });
 assert.equal(f.connected,false);assert.equal(f.context.pages().length,0);
});
test('unexpected popup is closed and aborts rather than silently spending another page',async()=>{
 const f=fixture();let closed=false;
 await assert.rejects(runGameTest({projectRoot:process.cwd(),governor:f.governor},async session=>{
  const b=await createGameBrowser(session,f.type);await b.page();
  const aborted=new Promise((_,reject)=>session.signal.addEventListener('abort',()=>reject(session.signal.reason),{once:true}));
  f.context.emit('page',{close:async()=>{closed=true;},opener:async()=>({})});
  await aborted;
 }),/unexpected_browser_page/);
 assert.equal(closed,true);assert.equal(f.connected,false);
});
test('a null-opener popup during allocation is not mistaken for the returned owned page',async()=>{
 const f=fixture();let extraClosed=false;
 await assert.rejects(runGameTest({projectRoot:process.cwd(),governor:f.governor},async session=>{
  const b=await createGameBrowser(session,f.type);await b.page();
  const original=f.context.newPage;
  f.context.newPage=async()=>{
   f.context.emit('page',{close:async()=>{extraClosed=true;},opener:async()=>null});
   return original();
  };
  await b.newPage();await new Promise(r=>setTimeout(r,5));session.signal.throwIfAborted();
 }),/unexpected_browser_page/);
 assert.equal(extraClosed,true);
});
test('the same admitted session cannot launch a second browser',async()=>{
 const f=fixture();let launches=0;const original=f.type.launch;
 f.type.launch=async()=>{launches++;return original();};
 await runGameTest({projectRoot:process.cwd(),governor:f.governor},async session=>{
  const results=await Promise.allSettled([createGameBrowser(session,f.type),createGameBrowser(session,f.type)]);
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1);assert.equal(launches,1);
 });
});
test('a retained closed session cannot launch resources after its slots are released',async()=>{
 const f=fixture();let saved,launches=0;
 f.type.launch=async()=>{launches++;throw new Error('should not launch');};
 await runGameTest({projectRoot:process.cwd(),governor:f.governor},async s=>{saved=s;});
 await assert.rejects(createGameBrowser(saved,f.type),/session_closed/);assert.equal(launches,0);
});
test('a rejected browser launch leaves admission quarantined because no handle proves closure',async()=>{
 const f=fixture(),releases=[];
 f.governor.acquireHostSlot=async()=>({heartbeat:async()=>{},release:async value=>releases.push(value)});
 f.type.launch=async()=>{throw new Error('lost launch response');};
 await assert.rejects(runGameTest({projectRoot:process.cwd(),governor:f.governor},s=>createGameBrowser(s,f.type)),/cleanup_uncertain/);
 assert.deepEqual(releases,[{quiescent:false},{quiescent:false}]);
});
test('a browser handle arriving after cancellation is closed while its released leases stay quarantined',async()=>{
 const f=fixture(),controller=new AbortController(),releases=[];
 let resolveLaunch,work;
 const original=f.type.launch;
 f.type.launch=()=>{controller.abort(new Error('cancel launch'));return new Promise(resolve=>{resolveLaunch=resolve;});};
 f.governor.acquireHostSlot=async()=>({heartbeat:async()=>{},release:async value=>releases.push(value)});
 await assert.rejects(runGameTest({projectRoot:process.cwd(),governor:f.governor,signal:controller.signal,cleanupMs:10},s=>{
  work=createGameBrowser(s,f.type);return work;
 }),/cleanup_uncertain/);
 assert.deepEqual(releases,[{quiescent:false},{quiescent:false}]);
 resolveLaunch(await original());
 await assert.rejects(work,/cancel launch/);
 assert.equal(f.connected,false);
 assert.deepEqual(releases,[{quiescent:false},{quiescent:false}]);
});
