#!/usr/bin/env node
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {runGameTest} from '../runtime/game-test-session.mjs';
import {runGameProcess} from '../runtime/game-test-process.mjs';

const projectRoot=realpathSync(process.cwd());
if(!process.env.ANDROID_HOME)throw new Error('ANDROID_HOME is required');
const argv=[join(process.env.ANDROID_HOME,'emulator/emulator'),'-avd','ForgewrightTestDevice',
 '-no-window','-no-audio','-no-boot-anim','-gpu','off'];
try {
 await runGameTest({projectRoot,resourceKind:'emulator',timeoutMs:1800000},session=>runGameProcess(session,argv,{cwd:projectRoot}));
} catch(error) {console.error(error.message);process.exitCode=1;}
