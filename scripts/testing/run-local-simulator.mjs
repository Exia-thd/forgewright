#!/usr/bin/env node
import {realpathSync} from 'node:fs';
import {runGameTest} from '../runtime/game-test-session.mjs';
import {createGameSimulator} from '../runtime/game-test-simulator.mjs';
if(process.argv.length!==4||process.argv[2]!=='--udid')throw new Error('Usage: node scripts/testing/run-local-simulator.mjs --udid <shutdown-device-UUID>');
try {
 await runGameTest({projectRoot:realpathSync(process.cwd()),resourceKind:'emulator',timeoutMs:1800000},async session=>{
  await createGameSimulator(session,process.argv[3]);
  console.error('Owned simulator booted; Ctrl-C closes this exact device.');
  await new Promise(resolve=>{session.signal.addEventListener('abort',resolve,{once:true});if(session.signal.aborted)resolve();});
 });
} catch(error){console.error(error.message);process.exitCode=1;}
