/** One owned browser/context; managed page requests are serialized and capped. */
export async function createGameBrowser(session, browserType, contextOptions={}) {
 session.claim('browser');
 let browser,attempted=false,closing;
 const close=async()=>{if(browser){closing??=browser.close();await closing;}else if(attempted)throw new Error('game_browser_launch_uncertain');};
 await session.own({close,isClosed:()=>browser?!browser.isConnected():!attempted});
 session.signal.throwIfAborted();attempted=true;
 browser=await browserType.launch({headless:true});
 if(session.signal.aborted)await close();
 session.signal.throwIfAborted();
 const context=await browser.newContext(contextOptions);
 const pages=new Set();const unexpected=[];let tail=Promise.resolve(),allocation,blocked=false;
 const violation=()=>{blocked=true;session.abort(new Error('game_unexpected_browser_page'));};
 context.on('page',page=>{
  const currentAllocation=allocation;
  unexpected.push(Promise.resolve(currentAllocation).then(async()=>{
   if(pages.has(page))return;
   // Popups may exist momentarily before this event; close them and fail the run.
   violation();await page.close();
  }).catch(()=>{violation();}));
 });
 async function allocate(reuse) {
  session.signal.throwIfAborted();
  if(blocked || !browser.isConnected())throw new Error('game_browser_uncertain');
  for(const page of pages)if(page.isClosed())pages.delete(page);
  if(reuse && pages.size)return pages.values().next().value;
  if(pages.size>=2)throw new Error('game_page_budget_exceeded');
  let finish;
  allocation=new Promise(resolve=>{finish=resolve;});
  try {const page=await context.newPage();pages.add(page);return page;}
  catch(error){violation();throw error;}
  finally {allocation=undefined;finish();}
 }
 const queue=reuse=>{const next=tail.then(()=>allocate(reuse));tail=next.catch(()=>{});return next;};
 await session.own({close:async()=>{await tail;await Promise.all(unexpected);await context.close();},
  isClosed:()=>context.pages().length===0});
 return Object.freeze({page:()=>queue(true),newPage:()=>queue(false),
  async closePage(page){if(!pages.has(page))throw new Error('game_foreign_page');await page.close();if(!page.isClosed()){violation();throw new Error('game_page_close_unconfirmed');}pages.delete(page);},
 });
}
