import {test,expect} from './demo-fixture';
import {readFile,mkdir,stat} from 'node:fs/promises';
import {createDocument,addRoom,onlyDoc,syntheticPhoto,upload,openDescription,finishDialog,evidence,noOverflow,reopenRoom} from './helpers';

test('V4: menu editor Escape возвращает focus к ellipsis на трёх маршрутах',async({page},info)=>{
  await createDocument(page);await addRoom(page);
  const observed:{route:string;returnedToEllipsis:boolean}[]=[];
  async function check(action:string,route:string){
    const opener=page.getByRole('button',{name:'Действия',exact:true});
    await opener.focus();await page.keyboard.press('Enter');
    await page.getByRole('dialog',{name:'Действия',exact:true}).getByRole('button',{name:action,exact:true}).click();
    await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);await expect(opener).toBeFocused();
    observed.push({route,returnedToEllipsis:true});
  }
  await check('Название и тип комнаты','room');
  await page.getByRole('button',{name:'К документу',exact:true}).click();await check('Изменить данные документа','document');
  await page.locator('.list-row').first().click();
  await page.getByRole('button',{name: /^Добавить(?: дефект)?$/,exact:true}).click();await page.getByLabel('Название дефекта').fill('Дефект фокуса');
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.locator('.list-row').filter({hasText:'Дефект фокуса'}).click();
  await check('Название дефекта','defect');await evidence(page,info,'v4-menu-editor-focus',{observed});
});

for(const viewport of [{width:430,height:887},{width:320,height:568}]){
  test(`V4: room ${viewport.width} baseline rhythm и 200% reachability`,async({page},info)=>{
    await page.setViewportSize(viewport);await createDocument(page);await addRoom(page);
    const description=await openDescription(page);await description.fill('Окна выходят на улицу, пол — ламинат.');await finishDialog(page);
    const jpeg=await syntheticPhoto(page,320,240);
    await upload(page,[jpeg]);await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.photos.length).toBe(1);
    await page.getByRole('button',{name:'Открыть фото 1',exact:true}).click();await page.getByLabel('Подпись к фото').fill('Вид комнаты со стороны входа');await page.keyboard.press('Escape');
    await page.getByRole('button',{name: /^Добавить(?: дефект)?$/,exact:true}).click();await page.getByLabel('Название дефекта').fill('Трещина над окном');
    await upload(page,[jpeg,jpeg]);await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.defects[0]!.photos.length).toBe(2);
    await page.getByRole('button',{name:'Сохранить',exact:true}).click();await noOverflow(page);
    const geometry=await page.locator('main').evaluate(main=>{
      const header=main.querySelector<HTMLElement>('.screen-header')!,columns=main.querySelector<HTMLElement>('.content-columns')!;
      const heading=main.querySelector('section:has(.photo-grid) h2')!.getBoundingClientRect();
      return {headerGap:getComputedStyle(header).gap,headerBottom:header.getBoundingClientRect().bottom,contentTop:columns.getBoundingClientRect().top,photoHeadingHeight:heading.height};
    });
    expect(geometry.headerGap).toBe('12px');expect(geometry.contentTop-geometry.headerBottom).toBe(24);expect(geometry.photoHeadingHeight).toBe(28);
    await evidence(page,info,`v4-room-${viewport.width}-normal`,{geometry});
    const stress=await openDescription(page);await stress.fill('Очень длинное описание для проверки переноса и достижимости последнего фото. '.repeat(12));await finishDialog(page);
    await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.description).toContain('Очень длинное описание');
    await expect(page.getByRole('status').filter({hasText:'Сохраняем'})).toHaveCount(0);
    await page.evaluate(()=>document.fonts.ready.then(()=>true));
    const scale=await page.evaluate(()=>{
      const rows=Array.from(document.querySelectorAll<HTMLElement>('h1,h2,p,label,button,input,textarea,a,summary,figcaption')).filter(node=>node.getClientRects().length).map(node=>({node,baseline:parseFloat(getComputedStyle(node).fontSize)}));
      for(const row of rows)row.node.style.fontSize=`${row.baseline*2}px`;
      return rows.map(row=>({tag:row.node.tagName,baseline:row.baseline,actual:parseFloat(getComputedStyle(row.node).fontSize)}));
    });
    for(const row of scale)expect(row.actual/row.baseline).toBeCloseTo(2,2);await noOverflow(page);
    const reachability=[];
    for(const selector of ['.photo-open','figcaption','.photo-add','section:has(.photo-grid) h2']){
      const node=page.locator(selector).last();await node.evaluate(el=>el.scrollIntoView({block:'center'}));
      const result=await node.evaluate(el=>{const r=el.getBoundingClientRect(),bar=document.querySelector('.action-bar')!.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {top:r.top,bottom:r.bottom,barTop:bar.top,viewport:innerHeight,hit:!!hit&&(el.contains(hit)||hit.contains(el))};});
      expect(result.top).toBeGreaterThanOrEqual(0);expect(result.bottom).toBeLessThanOrEqual(Math.min(result.barTop,result.viewport));expect(result.hit).toBe(true);reachability.push({selector,...result});
    }
    await evidence(page,info,`v4-room-${viewport.width}-200`,{scale,reachability});
  });
}

test('V4: OffscreenCanvas disabled — 28tiny+2noisy, настоящий bounded HTMLcanvas fallback',async({page},info)=>{
  await page.addInitScript(()=>Object.defineProperty(window,'OffscreenCanvas',{configurable:true,value:undefined}));
  await createDocument(page);await addRoom(page);
  await upload(page,[await syntheticPhoto(page,1800,1200,true,101),await syntheticPhoto(page,1800,1200,true,102)]);
  await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.photos.length).toBe(2);
  await page.getByRole('button',{name:'К документу',exact:true}).click();await addRoom(page,'Кухня');
  const id=(await onlyDoc(page)).id,tiny=(await syntheticPhoto(page,32,24)).toString('base64');
  await page.evaluate(async({id,tiny})=>{
    const bytes=Uint8Array.from(atob(tiny),char=>char.charCodeAt(0));
    for(const item of await indexedDB.databases()){
      if(!item.name)continue;
      const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(item.name!);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
      try{for(const name of Array.from(db.objectStoreNames)){
        const doc=await new Promise<any>((resolve,reject)=>{const request=db.transaction(name).objectStore(name).get(id);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
        if(!doc?.rooms)continue;
        const noisy=doc.rooms[0].photos;
        for(let index=0;index<2;index++)doc.rooms[index].photos=[...Array.from({length:14},(_,i)=>({id:crypto.randomUUID(),blob:new Blob([bytes],{type:'image/jpeg'}),width:32,height:24,caption:`Малое фото ${index+1}-${i+1}`})),noisy[index]];
        doc.revision+=1;doc.updatedAt=typeof doc.updatedAt==='string'?new Date().toISOString():Date.now();
        await new Promise<void>((resolve,reject)=>{const tx=db.transaction(name,'readwrite');tx.objectStore(name).put(doc);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
      }}finally{db.close();}
    }
  },{id,tiny});
  await page.reload();await reopenRoom(page);
  const before=await onlyDoc(page,false,true);
  expect(before.rooms.map(room=>room.photos.length)).toEqual([15,15]);
  await page.evaluate(()=>{
    const calls:{method:string;width:number;height:number;quality:unknown}[]=[];
    Object.assign(window,{__qaFallbackCalls:calls});
    const blob=HTMLCanvasElement.prototype.toBlob,data=HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toBlob=function(callback,type,quality){if(type==='image/jpeg')calls.push({method:'toBlob',width:this.width,height:this.height,quality});return blob.call(this,callback,type,quality);};
    HTMLCanvasElement.prototype.toDataURL=function(type,quality){if(type==='image/jpeg')calls.push({method:'toDataURL',width:this.width,height:this.height,quality});return data.call(this,type,quality);};
  });
  await page.getByRole('button',{name:'К документу',exact:true}).click();await page.getByRole('button',{name:/Сформировать PDF/}).click();
  await expect(page.getByRole('link',{name:'Скачать PDF'})).toBeVisible({timeout:15_000});
  const calls=await page.evaluate(()=>(window as unknown as {__qaFallbackCalls:{method:string;width:number;height:number;quality:unknown}[]}).__qaFallbackCalls);
  expect(calls.filter(call=>call.method==='toBlob')).toHaveLength(0);
  expect(calls.filter(call=>call.method==='toDataURL')).toHaveLength(2);
  const event=page.waitForEvent('download');await page.getByRole('link',{name:'Скачать PDF'}).click();
  await mkdir('docs/evidence/qa',{recursive:true});const file='docs/evidence/qa/actual-v4-fallback.pdf';await(await event).saveAs(file);
  const module='pdfjs-dist/legacy/build/pdf.mjs';const pdfjs=await import(module);const pdf=await pdfjs.getDocument({data:new Uint8Array(await readFile(file))}).promise;
  let images=0,text='';for(let n=1;n<=pdf.numPages;n++){const current=await pdf.getPage(n);const ops=await current.getOperatorList();images+=ops.fnArray.filter((op:number)=>[pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintInlineImageXObject].includes(op)).length;text+=(await current.getTextContent()).items.map((item:{str?:string})=>item.str||'').join(' ')+' ';}
  expect(images).toBe(30);for(const room of before.rooms)for(const photo of room.photos)if(photo.caption)expect(text).toContain(photo.caption);
  expect(await onlyDoc(page,false,true)).toEqual(before);
  await evidence(page,info,'v4-offscreen-disabled-fallback',{featureDisabled:true,fixture:'28 tiny valid JPEG preseed +2 real noisy UI uploads,15perroom',calls,images,bytes:(await stat(file)).size,idbByteAndMetadataIdentity:true});await pdf.destroy();
});
