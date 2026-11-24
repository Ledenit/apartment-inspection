import {test as base,type Browser,type BrowserContext} from './demo-fixture';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

export const test=base.extend({
  context:async({playwright,browserName,launchOptions,baseURL,viewport,locale,timezoneId,headless},use,info)=>{
    const options={baseURL,viewport,locale,timezoneId,acceptDownloads:true};
    const persistent=info.project.name==='webkit-managed-persistent';
    const profile=persistent?await mkdtemp(path.join(tmpdir(),'inspection-qa-webkit-')):undefined;
    let browser:Browser|undefined,context:BrowserContext|undefined;
    try{
      browser=persistent?undefined:await playwright[browserName].launch({...launchOptions,headless});
      context=profile?await playwright.webkit.launchPersistentContext(profile,{...launchOptions,...options,headless}):await browser!.newContext(options);
      // Playwright Test already manages context tracing through instrumentation.
      await use(context);
    }finally{
      await context?.close();await browser?.close();
      if(profile){
        if(path.resolve(path.dirname(profile))!==path.resolve(tmpdir())||!path.basename(profile).startsWith('inspection-qa-webkit-'))throw new Error('Unexpected QA temporary profile path');
        await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200});
      }
    }
  },
});
