import {test as base,expect} from './demo-fixture';
import {createServer as createHttpServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer as createViteServer} from 'vite';
import {createDocument,addRoom,openDescription,finishDialog,onlyDoc} from './helpers';
import {decodeRenderedSiteQR} from './pdf-site-render';

const test=base.extend<{siteConfig:string;siteURL:string}>({
  siteConfig:['',{option:true}],
  baseURL: async ({ siteURL }, use) => { await use(siteURL); },
  siteURL:async({siteConfig},use)=>{
    // Config is isolated to this Vite instance. Never change process.env, .env,4173 or the user profile.
    const vite=await createViteServer({envFile:false,define:{'import.meta.env.VITE_PUBLIC_SITE_URL':JSON.stringify(siteConfig)},server:{middlewareMode:true,hmr:false}});
    let server:Server|undefined;
    try{
      server=createHttpServer((request,response)=>{
        if (request.url?.split('?')[0] === '/site-config.json') {
          response.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
          response.end(JSON.stringify({publicSiteUrl:siteConfig}));
        } else vite.middlewares(request,response);
      });
      await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>resolve());});
      await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }finally{
      if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
      await vite.close();
    }
  },
  context:async({browser,siteURL},use)=>{
    const context=await browser.newContext({baseURL:siteURL,viewport:{width:430,height:887},locale:'ru-RU',timezoneId:'Asia/Yekaterinburg'});
    await use(context);await context.close();
  },
});

const longURL='HTTPS://Example.test:443/inspection/'+ 'level-0123456789/'.repeat(23)+'?source=qa&note=room%20test#public';
const configurations=[{key:'empty',raw:'',valid:true,long:false},{key:'canonical',raw:'HTTPS://Example.test:443/public?q=qa%20check#guide',valid:true,long:false},{key:'long',raw:longURL,valid:true,long:true},{key:'invalid-scheme',raw:'javascript:alert(1)',valid:false,long:false},{key:'invalid-userinfo',raw:'https://qa:synthetic@example.test/private',valid:false,long:false},{key:'invalid-control',raw:'https://example.test/a\nb',valid:false,long:false}];

for(const configuration of configurations){
  test.describe(configuration.key,()=>{
    test.use({siteConfig:configuration.raw});
    test(`PDF site/QR ${configuration.key}: real browser export,URI,pixels,IDB`,async({page,context},info)=>{
      test.setTimeout(150_000);
      const external:string[]=[],errors:string[]=[];
      context.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).hostname!=='127.0.0.1')external.push(request.url());});
      await context.route('**/*',route=>/^https?:/.test(route.request().url())&&new URL(route.request().url()).hostname!=='127.0.0.1'?route.abort():route.continue());
      page.on('pageerror',error=>errors.push(error.message));
      await createDocument(page,'QA сайт PDF, синтетический адрес');
      if(configuration.long){const field=await openDescription(page);await field.fill('Синтетическое описание для проверки переноса финального блока. '.repeat(250));await finishDialog(page);}
      await addRoom(page);await page.getByRole('button',{name:'К документу',exact:true}).click();
      const before=await onlyDoc(page,false,true);
      await page.getByRole('button',{name:/Сформировать PDF/}).click();
      if(!configuration.valid){
        await expect(page.getByRole('alert')).toContainText(/Не получилось создать PDF/);
        await expect(page.getByRole('link',{name:'Скачать PDF'})).toHaveCount(0);
        expect(await onlyDoc(page,false,true)).toEqual(before);expect(external).toEqual([]);expect(errors).toEqual([]);
        await mkdir('docs/evidence/qa',{recursive:true});
        await page.screenshot({path:`docs/evidence/qa/pdf-site-${configuration.key}-error.png`,fullPage:true});
        const artifact=`docs/evidence/qa/pdf-site-${configuration.key}-inspection.json`;
        await writeFile(artifact,JSON.stringify({expected:'generic export error, no download',alert:await page.getByRole('alert').innerText(),idbIdentity:true,external,errors},null,2),'utf8');
        await info.attach('site-pdf-negative-inspection',{path:artifact,contentType:'application/json'});return;
      }
      await expect(page.getByRole('link',{name:'Скачать PDF'})).toBeVisible();
      await expect(page.locator('iframe.pdf-preview')).toBeVisible();
      const event=page.waitForEvent('download');await page.getByRole('link',{name:'Скачать PDF'}).click();
      await mkdir('docs/evidence/qa',{recursive:true});const file=`docs/evidence/qa/pdf-site-${configuration.key}.pdf`;await(await event).saveAs(file);
      expect(await onlyDoc(page,false,true)).toEqual(before);expect(external).toEqual([]);expect(errors).toEqual([]);
      const module='pdfjs-dist/legacy/build/pdf.mjs',pdfjs=await import(module);
      const pdf=await pdfjs.getDocument({data:new Uint8Array(await readFile(file))}).promise;
      const pages:{page:number;width:number;height:number;items:{str:string;x:number;y:number;width:number;height:number}[];links:{uri:string;raw:string;rect:number[]}[]}[]=[];
      for(let n=1;n<=pdf.numPages;n++){
        const current=await pdf.getPage(n),content=await current.getTextContent(),annotations=await current.getAnnotations();
        const items=content.items.filter((item:{str?:string})=>typeof item.str==='string').map((item:{str:string;transform:number[];width:number;height:number})=>({str:item.str,x:item.transform[4],y:item.transform[5],width:item.width,height:item.height}));
        pages.push({page:n,width:current.view[2]-current.view[0],height:current.view[3]-current.view[1],items,links:annotations.filter((a:{subtype:string})=>a.subtype==='Link').map((a:{url?:string;unsafeUrl?:string;rect:number[]})=>({uri:a.url||'',raw:a.unsafeUrl||a.url||'',rect:a.rect}))});
      }
      const allText=pages.flatMap(p=>p.items.map(i=>i.str)).join(' '),links=pages.flatMap(p=>p.links.map(link=>({...link,page:p.page})));
      expect(allText.match(/Дата осмотра:/g)).toHaveLength(1);expect(allText).toMatch(/Дата осмотра:\s*03\.02\.2026\s*$/);
      const decoded=await decodeRenderedSiteQR(page,info,file,configuration.key,pdf.numPages);
      if(!configuration.raw){expect(links).toEqual([]);expect(decoded).toEqual([]);expect(allText).not.toContain('Вернуться на сайт');}
      else{
        const expected=new URL(configuration.raw).href,last=pages.at(-1)!;
        expect(allText.match(/Вернуться на сайт/g)).toHaveLength(1);
        expect(links.length).toBeGreaterThan(0);for(const link of links){expect(link.uri).toBe(expected);expect(link.raw).toBe(expected);expect(link.page).toBe(pdf.numPages);expect(link.rect[0]).toBeGreaterThanOrEqual(0);expect(link.rect[1]).toBeGreaterThanOrEqual(0);expect(link.rect[2]).toBeLessThanOrEqual(last.width);expect(link.rect[3]).toBeLessThanOrEqual(last.height);}
        const urlItems=last.items.filter(item=>item.str.trim()&&expected.includes(item.str.replace(/\s/g,''))&&links.some(link=>item.x+item.width>=link.rect[0]-1&&item.x<=link.rect[2]+1&&item.y>=link.rect[1]-3&&item.y<=link.rect[3]+3)).sort((a,b)=>b.y-a.y||a.x-b.x);
        expect(urlItems.map(item=>item.str).join('').replace(/\s/g,'')).toBe(expected);
        for(const item of urlItems){expect(item.x).toBeGreaterThanOrEqual(0);expect(item.x+item.width).toBeLessThanOrEqual(last.width+0.5);expect(item.y).toBeGreaterThanOrEqual(0);expect(item.y+item.height).toBeLessThanOrEqual(last.height+0.5);}
        if(configuration.long){expect(pdf.numPages).toBeGreaterThan(1);expect(new Set(urlItems.map(item=>item.y)).size).toBeGreaterThan(1);}
        expect(decoded).toHaveLength(1);expect(decoded[0]!.data).toBe(expected);expect(decoded[0]!.page).toBe(pdf.numPages);
        const legal=last.items.find(item=>item.str.startsWith('Документ составлен пользователем'))!,date=last.items.find(item=>item.str.startsWith('Дата осмотра:'))!;
        expect(legal).toBeTruthy();expect(date).toBeTruthy();expect(date.y).toBeLessThan(legal.y);
        expect(Math.min(...links.map(link=>link.rect[1]))).toBeGreaterThan(legal.y+legal.height);expect(decoded[0]!.rect[1]).toBeGreaterThan(legal.y+legal.height);
      }
      const artifact=`docs/evidence/qa/pdf-site-${configuration.key}-inspection.json`;await writeFile(artifact,JSON.stringify({canonical:configuration.raw?new URL(configuration.raw).href:null,pages,decoded,idbIdentity:true,external,errors},null,2),'utf8');await info.attach('site-pdf-inspection',{path:artifact,contentType:'application/json'});await pdf.destroy();
    });
  });
}
