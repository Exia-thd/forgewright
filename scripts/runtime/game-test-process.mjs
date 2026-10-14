/** Supervise a cooperative POSIX child group; never signal by name or port. */
import {spawn} from 'node:child_process';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const groupAlive=pid=>{try{process.kill(-pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;if(process.platform==='darwin'&&error.code==='EPERM')return true;throw error;}};

export async function runGameProcess(session,argv,{cwd=process.cwd(),onSpawn}={}) {
 if(process.platform==='win32')throw new Error('game_process_platform_unavailable');
 if(!Array.isArray(argv)||!argv.length||argv.some(v=>typeof v!=='string'||!v||v.includes('\0')))throw new Error('game_invalid_argv');
 session.claim('emulator');
 const child=spawn(argv[0],argv.slice(1),{cwd,detached:true,shell:false,stdio:['ignore','pipe','pipe']});
 let started=false;
 const result=new Promise((resolve,reject)=>{
  child.once('spawn',()=>{started=true;try{onSpawn?.(child.pid);}catch(error){reject(error);}});
  child.once('error',reject);
  child.once('exit',(code,signal)=>{if(code===0)resolve({exitCode:code});else reject(new Error(`game_process_exit:${code ?? signal}`));});
 });
 // Attach rejection observation before registering ownership/awaiting work.
 void result.catch(()=>{});
 const terminate=signal=>{if(!started||!groupAlive(child.pid))return;try{process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH'&&!(process.platform==='darwin'&&error.code==='EPERM'))throw error;}};
 const abort=()=>{try{terminate('SIGTERM');}catch{/* Final cleanup retains the slot on failure. */}};
 session.signal.addEventListener('abort',abort,{once:true});
 let bytes=0;
 for(const [stream,target] of [[child.stdout,process.stdout],[child.stderr,process.stderr]])stream.on('data',chunk=>{
  bytes+=chunk.length;
  if(bytes>1024*1024)session.abort(new Error('game_process_output_limit'));else target.write(chunk);
 });
 await session.own({
  async close(){
   session.signal.removeEventListener('abort',abort);
   // The spawn event can still arrive after cancellation or registration.
   await new Promise(resolve=>{if(started||child.pid===undefined)resolve();else {child.once('spawn',resolve);child.once('error',resolve);}});
   if(!started)return;
   terminate('SIGTERM');
   for(let i=0;i<20&&groupAlive(child.pid);i++)await pause(25);
   if(groupAlive(child.pid))terminate('SIGKILL');
   for(let i=0;i<80&&groupAlive(child.pid);i++)await pause(25);
   if(groupAlive(child.pid))throw new Error('game_process_cleanup_unconfirmed');
  },
  isClosed:()=>!started||!groupAlive(child.pid),
 });
 if(session.signal.aborted)abort();
 return result;
}
