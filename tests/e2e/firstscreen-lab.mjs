import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile,stat,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createApi} from '../../server-dist/api.js';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

const output=path.resolve(process.env.QA_FIRSTSCREEN_EVIDENCE_DIR||'docs/evidence/qa/firstscreen-current');await mkdir(output,{recursive:true});
const dist=path.resolve('dist'),config=await readFile('nginx.example.conf','utf8');
const headers={};for(const match of config.matchAll(/add_header\s+(\S+)\s+(?:"([^"]*)"|(\S+))\s+always;/g))headers[match[1]]=match[2]??match[3];
if(!headers['Content-Security-Policy']||headers['Cache-Control']!=='no-cache')throw new Error('Expected nginx security/cache headers');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.ttf':'font/ttf','.json':'application/json'};
const compression={enabled:/\bgzip\s+on\s*;/.test(config),vary:/\bgzip_vary\s+on\s*;/.test(config),minLength:Number(config.match(/\bgzip_min_length\s+(\d+)\s*;/)?.[1]||20),level:Number(config.match(/\bgzip_comp_level\s+(\d+)\s*;/)?.[1]||1),types:['text/html',...(config.match(/\bgzip_types\s+([^;]+);/)?.[1]||'').trim().split(/\s+/)]};
const api=await createApi({dataDir:await mkdtemp(path.join(tmpdir(),'inspection-firstscreen-'))});
const server=createServer(async(request,response)=>{
  try{
    if(await api.handle(request,response))return;
    const requested=path.resolve(dist,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
    if(requested!==dist&&!requested.startsWith(dist+path.sep)){response.writeHead(403);response.end();return;}
    let file=requested;try{if(!(await stat(file)).isFile())file=path.join(dist,'index.html');}catch{file=path.join(dist,'index.html');}
    const original=await readFile(file),type=mime[path.extname(file)]||'application/octet-stream';
    const eligible=compression.enabled&&original.length>=compression.minLength&&compression.types.includes(type),compressed=eligible&&/(?:^|,)\s*gzip(?:\s*(?:,|$)|\s*;q=(?!0(?:\.0*)?(?:,|$)))/.test(request.headers['accept-encoding']||'');
    const body=compressed?gzipSync(original,{level:compression.level}):original;
    response.writeHead(200,{...headers,'Content-Type':type,'Content-Length':body.length,...(eligible&&compression.vary?{'Vary':'Accept-Encoding'}:{}),...(compressed?{'Content-Encoding':'gzip'}:{})});response.end(body);
  }catch{response.writeHead(500);response.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const profile={downBitsPerSecond:4_000_000,upBitsPerSecond:1_000_000,latencyMilliseconds:150,cpuRate:1,viewport:{width:430,height:887},cacheDisabled:true,serviceWorkersBlocked:true};
const records=[];
let followupContext,followupPage,followup;
try{
  for(let run=1;run<=3;run++){
    const context=await browser.newContext({viewport:profile.viewport,locale:'ru-RU',timezoneId:'Asia/Yekaterinburg',serviceWorkers:'block'});
    const page=await context.newPage(),errors=[],external=[],responses=[],pendingResponses=[];
    page.on('response',response=>{pendingResponses.push(response.allHeaders().then(value=>responses.push({url:response.url(),status:response.status(),headers:value})));});
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(origin+'/'))external.push(request.url());});
    await page.addInitScript(()=>{
      window.__qaPaint=[];window.__qaLCP=[];
      new PerformanceObserver(list=>window.__qaPaint.push(...list.getEntries().map(e=>({name:e.name,startTime:e.startTime})))).observe({type:'paint',buffered:true});
      new PerformanceObserver(list=>window.__qaLCP.push(...list.getEntries().map(e=>({startTime:e.startTime,size:e.size,url:e.url||'',element:e.element?.tagName||''})))).observe({type:'largest-contentful-paint',buffered:true});
    });
    const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Network.setBypassServiceWorker',{bypass:true});
    await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:4_000_000/8,uploadThroughput:1_000_000/8});await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
    const record={run,environment:{version:browser.version(),userAgent:await page.evaluate(()=>navigator.userAgent)},profile,headers,compression,errors,external,responses};let timer;
    try{
      const ready=async()=>{
        await page.goto(origin,{waitUntil:'domcontentloaded',timeout:15_000});
        await page.getByRole('heading',{name:'Вход в демонстрацию',exact:true}).waitFor({state:'visible',timeout:15_000});
        await page.getByRole('button',{name:'Войти',exact:true}).waitFor({state:'visible',timeout:15_000});
        return page.evaluate(async()=>{
          const button=Array.from(document.querySelectorAll('button')).find(node=>node.textContent.trim()==='Войти');
          if(!button||button.disabled)throw new Error('Demo login is not enabled');
          const fields=Array.from(document.querySelectorAll('input')).map(input=>input.value);
          if(fields[0]!=='70000000000'||fields[1]!=='0000')throw new Error('Demo fields are not prefilled');
          await document.fonts.ready;
          await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
          const readyMs=performance.now();
          return {readyMs,firstScreen:'demo-login',fields,fonts:Array.from(document.fonts).map(f=>({family:f.family,weight:f.weight,status:f.status})),navigation:performance.getEntriesByType('navigation').map(e=>e.toJSON()),resources:performance.getEntriesByType('resource').map(e=>e.toJSON()),paint:window.__qaPaint,lcp:window.__qaLCP};
        });
      };
      record.metrics=await Promise.race([ready(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Bounded navigation-to-ready timeout15000ms')),15_000);})]);
      await Promise.all(pendingResponses);
      record.withinThreeSeconds=record.metrics.readyMs<=3000;
      const resources=record.metrics.resources,nav=record.metrics.navigation[0];
      record.resourceSummary={requests:resources.length+1,transferBytes:resources.reduce((sum,e)=>sum+e.transferSize,nav.transferSize),encodedBytes:resources.reduce((sum,e)=>sum+e.encodedBodySize,nav.encodedBodySize),eagerPDFChunks:resources.filter(e=>/\/pdf-[^/]+\.js(?:\?|$)/.test(e.name)).map(e=>e.name),slowest:resources.map(e=>({name:new URL(e.name).pathname,bytes:e.transferSize,start:e.startTime,duration:e.duration,end:e.responseEnd})).sort((a,b)=>b.end-a.end)};
      await page.screenshot({path:path.join(output,`cold-${run}.png`),fullPage:false});
    }catch(error){record.error=String(error);record.withinThreeSeconds=false;}finally{
      clearTimeout(timer);
      if(run===3&&!record.error&&process.env.QA_FIRSTSCREEN_FOLLOWUP==='1'){followupContext=context;followupPage=page;}else await context.close();
    }
    records.push(record);await writeFile(path.join(output,`cold-${run}.json`),JSON.stringify(record,null,2));
    console.log(JSON.stringify({run,readyMs:record.metrics?.readyMs,withinThreeSeconds:record.withinThreeSeconds,error:record.error,resources:record.resourceSummary?.requests,transferBytes:record.resourceSummary?.transferBytes}));
  }
  if(followupPage){
    let timer;
    try{
      followup=await Promise.race([(async()=>{
        await followupPage.getByRole('button',{name:'Войти',exact:true}).click();
        await followupPage.getByRole('heading',{name:'Пока нет документов',exact:true}).waitFor({state:'visible'});
        await followupPage.locator('.empty-art img').evaluate(image=>image.decode());
        const pixelProof=await followupPage.evaluate(async()=>{
          const served=document.querySelector('.empty-art img').currentSrc;
          if(!served.endsWith('.png'))throw new Error('Expected the preserved original PNG');
          const response=await fetch(served),blob=await response.blob();if(blob.type!=='image/png')throw new Error('Original PNG MIME mismatch');return {served,type:blob.type,bytes:blob.size,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).map(n=>n.toString(16).padStart(2,'0')).join('')};
        });
        if(pixelProof.type==='image/png'&&pixelProof.sha256!==createHash('sha256').update(await readFile('public/assets/822e16ff-44b9-463a-8f2f-cf3779351d16.png')).digest('hex'))throw new Error('Served original PNG bytes changed');
        await followupPage.getByRole('button',{name:'Новый документ',exact:true}).click();
        await followupPage.getByLabel(/^адрес/i).fill('QA cold firstscreen lab');await followupPage.keyboard.press('Tab');
        const readDocs=()=>followupPage.evaluate(async()=>{
          const rows=[];for(const entry of await indexedDB.databases()){if(!entry.name)continue;const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(entry.name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{for(const name of db.objectStoreNames){const values=await new Promise((resolve,reject)=>{const request=db.transaction(name).objectStore(name).getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});for(const value of values)if(value&&typeof value==='object'&&'address'in value&&'rooms'in value)rows.push(value);}}finally{db.close();}}return rows;
        });
        for(let attempt=0;attempt<30;attempt++){if((await readDocs()).some(doc=>doc.address==='QA cold firstscreen lab'))break;await followupPage.waitForTimeout(100);}
        const before=await readDocs();if(before.length!==1||before[0].address!=='QA cold firstscreen lab')throw new Error('Synthetic document not persisted');
        await followupPage.getByRole('button',{name:'В библиотеку',exact:true}).click();await followupPage.locator('.list-row').filter({hasText:'QA cold firstscreen lab'}).waitFor({state:'visible',timeout:5000});
        await followupPage.screenshot({path:path.join(output,'filled-430.png')});await followupPage.reload();await followupPage.locator('.list-row').filter({hasText:'QA cold firstscreen lab'}).waitFor({state:'visible',timeout:5000});
        const after=await readDocs();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('IDB changed after reload');
        await followupPage.setViewportSize({width:1366,height:768});await followupPage.screenshot({path:path.join(output,'filled-1366.png')});
        return {pixelProof,before,after,idbIdentity:true};
      })(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Bounded followup timeout15000ms')),15000);})]);
    }catch(error){followup={error:String(error)};}finally{clearTimeout(timer);await followupContext.close();}
    await writeFile(path.join(output,'followup.json'),JSON.stringify(followup,null,2));
  }
  await writeFile(path.join(output,'summary.json'),JSON.stringify({laboratoryOnly:true,real4GAcceptance:'OPEN',profile,thresholdMs:3000,runs:records,allWithinThreeSeconds:records.every(r=>r.withinThreeSeconds),followup},null,2));
  // Aggregate only after all three samples; preserve their evidence even when the threshold fails.
  process.exitCode=followup?.error||records.some(r=>!r.withinThreeSeconds||r.error||r.errors.length||r.external.length||r.resourceSummary?.eagerPDFChunks.length)?1:0;
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
