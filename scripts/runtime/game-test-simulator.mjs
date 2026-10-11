/** Exact-UDID lifecycle obligation; ambiguity never grants shutdown authority. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const defaultRun=async argv=>(await execute('xcrun',argv,{timeout:30000,maxBuffer:1024*1024})).stdout;

export async function createGameSimulator(session,udid,{run=defaultRun}={}) {
 if(typeof udid!=='string'||!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(udid)||!/^[a-f0-9-]+$/i.test(udid))throw new Error('game_invalid_simulator_udid');
 session.claim('emulator');
 const read=async()=>{
  const listing=JSON.parse(await run(['simctl','list','devices','--json']));
  if(!listing.devices||typeof listing.devices!=='object'||Array.isArray(listing.devices)||Object.values(listing.devices).some(v=>!Array.isArray(v)))throw new Error('game_simulator_listing_invalid');
  const matches=Object.values(listing.devices).flat().filter(v=>typeof v?.udid==='string'&&v.udid.toLowerCase()===udid.toLowerCase());
  if(matches.length!==1||matches[0].isAvailable!==true)throw new Error('game_simulator_unavailable');
  return matches[0].state;
 };
 if(await read()!=='Shutdown')throw new Error('game_simulator_not_owned');
 let attempted=false,confirmed=false,closed=false,closing;
 const close=async()=>{
   if(!attempted){closed=true;return;}
   if(!confirmed)throw new Error('game_simulator_boot_uncertain');
   closing??=(async()=>{
    await run(['simctl','shutdown',udid]);
    if(await read()!=='Shutdown')throw new Error('game_simulator_shutdown_unconfirmed');
    closed=true;
   })();
   await closing;
 };
 await session.own({close,
  isClosed:()=>closed||!attempted,
 });
 session.signal.throwIfAborted();attempted=true;
 await run(['simctl','boot',udid]);confirmed=true;
 if(session.signal.aborted)await close();
 session.signal.throwIfAborted();
 if(await read()!=='Booted')throw new Error('game_simulator_boot_unconfirmed');
 return Object.freeze({udid});
}
