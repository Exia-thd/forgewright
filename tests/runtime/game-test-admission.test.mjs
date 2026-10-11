import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {runGameTest} from '../../scripts/runtime/game-test-session.mjs';
import {getHostAdmissionStatus} from '../../integrations/pi/host-governor.mjs';
const self=fileURLToPath(import.meta.url);
const root=fileURLToPath(new URL('../..',import.meta.url));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function execute(argv,env,cwd,{cancelAfter,expectedExit=0}={}) {
 return new Promise((resolve,reject)=>{
  const child=spawn(argv[0],argv.slice(1),{env,cwd,shell:false,stdio:['ignore','pipe','pipe']});
  let output='',cancelled=false;
  const collect=b=>{output+=b;if(cancelAfter&&!cancelled&&output.includes(cancelAfter)){cancelled=true;child.kill('SIGTERM');}};
  child.stdout.on('data',collect);child.stderr.on('data',collect);child.once('error',reject);
  child.once('close',code=>{if(code!==expectedExit)reject(new Error(output));else resolve(output);});
 });
}
if(process.argv[2]==='status') {
 console.log(JSON.stringify(await getHostAdmissionStatus()));
} else if(process.argv[2]==='child') {
 await runGameTest({projectRoot:process.argv[3],runId:`game-${process.pid}`,waitMs:30000,timeoutMs:Number(process.argv[6]??120000)},async session=>{
  if(process.argv[5]==='quarantine'){await session.own({close:async()=>{throw new Error('uncertain resource');},isClosed:()=>false});return;}
  const marker=process.argv[4];writeFileSync(marker,'active',{flag:'wx'});
  try {const state=await getHostAdmissionStatus();assert.equal(state.active_heavy,1);await pause(Number(process.argv[5]??100));}
  finally {rmSync(marker);}
 });
} else {
 test('independent processes share one heavy slot and generated emulator launches are supervised', {timeout:90000},async()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'fw-game-')));const home=join(dir,'admission');
  const env={...process.env,FORGEWRIGHT_ADMISSION_HOME:home};
  let broker;
  try {
   // Frozen healthy telemetry exercises real IPC/transactions under controlled
   // conditions. This is not certification of this host's OS pressure signals.
   const bootstrap="import sys;sys.path.insert(0,sys.argv[1]);import host_admission_broker as b;from host_admission import HostAdmission;from host_resources import MemorySnapshot,GIB;b.HostAdmission=lambda home:HostAdmission(home,sensor=lambda:MemorySnapshot(8*GIB,7*GIB,'normal','test-frozen',0.1));b.serve(sys.argv[2])";
   broker=spawn('python3',['-B','-c',bootstrap,join(root,'scripts/runtime'),home],{stdio:['ignore','ignore','pipe']});
   let errors='';broker.stderr.on('data',b=>errors+=b);
   for(let i=0;i<200&&!existsSync(join(home,'broker.sock'));i++)await pause(25);
   assert.equal(existsSync(join(home,'broker.sock')),true,errors);
   const projects=Array.from({length:3},(_,i)=>{const p=join(dir,`p${i}`);mkdirSync(p);return p;});
   await Promise.all(projects.map(p=>execute([process.execPath,self,'child',p,join(dir,'active')],env,root)));
   const held=join(dir,'held');const forbidden=join(dir,'cancelled-effect');
   const holder=execute([process.execPath,self,'child',projects[0],held,'800'],env,root);
   for(let i=0;i<200&&!existsSync(held);i++)await pause(10);
   assert.equal(existsSync(held),true);
   const cancelled=await execute([process.execPath,self,'child',projects[1],forbidden,'100','30'],env,root,{expectedExit:1});
   assert.match(cancelled,/game_timeout/);await holder;assert.equal(existsSync(forbidden),false);
   const project=projects[0];
   const sdk=join(dir,'fake sdk');mkdirSync(join(sdk,'cmdline-tools/latest/bin'),{recursive:true});mkdirSync(join(sdk,'emulator'));
   for(const name of ['sdkmanager','avdmanager'])writeFileSync(join(sdk,'cmdline-tools/latest/bin',name),'#!/bin/sh\nexit 0\n',{mode:0o700});
   writeFileSync(join(sdk,'emulator/emulator'),`#!/usr/bin/env node\nconst fs=require('node:fs');const marker=${JSON.stringify(join(dir,'emulator-active'))};fs.writeFileSync(marker,'active',{flag:'wx'});console.log('MANAGED_EMULATOR_STARTED');setTimeout(()=>{fs.unlinkSync(marker);process.exit(0);},100);\n`,{mode:0o700});
   const emulatorEnv={...env,ANDROID_HOME:sdk};
   await execute(['bash',join(root,'scripts/testing/setup-local-emulators.sh')],emulatorEnv,project);
   const results=await Promise.all([1,2].map(()=>execute(['bash','scripts/start-emulator.sh'],emulatorEnv,project)));
   assert.equal(results.filter(out=>out.includes('MANAGED_EMULATOR_STARTED')).length,2);
   assert.equal(existsSync(join(dir,'emulator-active')),false);
   const udid='12345678-1234-1234-1234-123456789abc';const other='87654321-1234-1234-1234-123456789abc';
   const simulatorState=join(dir,'simulator-state.json');writeFileSync(simulatorState,JSON.stringify({[udid]:'Shutdown',[other]:'Booted'}));
   mkdirSync(join(sdk,'bin'));
   writeFileSync(join(sdk,'bin/xcrun'),`#!/usr/bin/env node\nconst fs=require('node:fs');const path=${JSON.stringify(simulatorState)};const d=JSON.parse(fs.readFileSync(path));const a=process.argv.slice(2);if(a[0]!=='simctl')process.exit(3);if(a[1]==='list'){console.log(JSON.stringify({devices:{runtime:Object.entries(d).map(([udid,state])=>({udid,state,isAvailable:true}))}}));}else{if(a[2]!==${JSON.stringify(udid)})process.exit(4);d[a[2]]=a[1]==='boot'?'Booted':'Shutdown';fs.writeFileSync(path,JSON.stringify(d));}\n`,{mode:0o700});
   const simulatorEnv={...env,PATH:join(sdk,'bin')+':'+process.env.PATH};
   const outcome=await execute([process.execPath,join(root,'scripts/testing/run-local-simulator.mjs'),'--udid',udid],simulatorEnv,project,{cancelAfter:'Owned simulator booted',expectedExit:1});
   assert.match(outcome,/game_cancelled/);
   assert.deepEqual(JSON.parse(readFileSync(simulatorState)),{[udid]:'Shutdown',[other]:'Booted'});
   await execute([process.execPath,self,'child',projects[0],join(dir,'unused'),'quarantine'],env,root,{expectedExit:1});
   const blocked=await execute([process.execPath,self,'child',projects[1],forbidden,'100','300'],env,root,{expectedExit:1});
   assert.match(blocked,/game_timeout/);assert.equal(existsSync(forbidden),false);
   const status=JSON.parse(await execute([process.execPath,self,'status'],env,root));
   assert.ok(status.quarantined>=2,'uncertainty retains worker and heavy reservations');
  } finally {
   const deadline=Date.now()+18000;
   while(existsSync(join(home,'broker.sock'))&&Date.now()<deadline)await pause(100);
   assert.equal(existsSync(join(home,'broker.sock')),false,'owned demand-started broker must exit idle');
   if(broker?.exitCode===null){broker.kill();await new Promise(r=>broker.once('exit',r));}
   rmSync(dir,{recursive:true,force:true});
  }
 });
}
