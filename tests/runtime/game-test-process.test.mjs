import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {runGameTest} from '../../scripts/runtime/game-test-session.mjs';
import {runGameProcess} from '../../scripts/runtime/game-test-process.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const governor={acquireHostSlot:async({kind})=>({id:kind,heartbeat:async()=>{},release:async({quiescent})=>assert.equal(quiescent,true)})};
const live=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
test('timeout reclaims owned process group while an unrelated sentinel survives',async()=>{
 const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 let owned;
 try {
  await assert.rejects(runGameTest({projectRoot:process.cwd(),governor,resourceKind:'emulator',timeoutMs:200},session=>
   runGameProcess(session,[process.execPath,'-e','setInterval(()=>{},1000)'],{onSpawn:pid=>{owned=pid;}})),/timeout/);
  assert.ok(owned);assert.equal(live(owned),false);assert.equal(live(sentinel.pid),true);
 } finally {sentinel.kill();await new Promise(r=>sentinel.once('exit',r));}
});
test('normal exit with a still-running descendant also closes the owned group',async()=>{
 let group;
 const script="require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setTimeout(()=>process.exit(0),100)";
 await runGameTest({projectRoot:process.cwd(),governor,resourceKind:'emulator'},session=>runGameProcess(session,[process.execPath,'-e',script],{onSpawn:pid=>{group=pid;}}));
 assert.throws(()=>process.kill(-group,0),{code:'ESRCH'});
});
test('a spawn failure releases without pretending a process was started',async()=>{
 await assert.rejects(runGameTest({projectRoot:process.cwd(),governor,resourceKind:'emulator'},session=>runGameProcess(session,['/nonexistent-forgewright-emulator'])),/ENOENT/);
});
