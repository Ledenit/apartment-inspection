import {expect} from './demo-fixture';
import {test} from './crossbrowser-fixture';
import {readFile,mkdir,stat,writeFile} from 'node:fs/promises';
import {observeErrors,completeErrorEvidence} from './error-observer';
import {createDocument,setInspectionDate,documents,addRoom,onlyDoc,syntheticPhoto,upload,reopenRoom,evidence,noOverflow} from './helpers';

test('crossbrowser: general checklist, help without rooms, full photo copy and PDF file', async ({page},info) => {
  const errors:string[]=[],external:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).hostname!=='127.0.0.1')external.push(r.url());});
  if(info.project.name==='firefox-installed-bidi-realkeys') {
    await page.goto('/');await page.getByRole('button',{name:/Новый документ/}).click();await setInspectionDate(page,'2026-02-03');
    const field=page.getByLabel(/^адрес/i);await field.fill('');await field.pressSequentially('QA copy crossbrowser 24');await field.press('Tab');
    await expect.poll(async()=>(await documents(page)).length).toBe(1);
  } else await createDocument(page,'QA copy crossbrowser 24');
  await page.getByRole('button',{name:'В библиотеку',exact:true}).click();
  await page.locator('.list-row').first().click();
  await page.getByRole('button',{name:'Не знаете, что фиксировать?',exact:true}).click();
  await expect(page.getByRole('combobox')).toHaveValue('Общее');
  await page.getByRole('button',{name:'К документу',exact:true}).click();
  await page.getByRole('button',{name:/Проверено/}).click();
  await page.getByRole('checkbox',{name:'Ключи',exact:true}).check();
  await expect.poll(async()=>(await onlyDoc(page) as any).generalCheckedItemIds).toEqual(['general-keys']);
  await addRoom(page);await upload(page,[await syntheticPhoto(page,320,240)]);
  await expect.poll(async()=>(await onlyDoc(page)).rooms[0].photos.length).toBe(1);
  await page.getByRole('button',{name:'К документу',exact:true}).click();
  const before=await onlyDoc(page,false,true);
  await page.getByRole('button',{name:'Действия',exact:true}).click();
  await page.getByRole('button',{name:'Дублировать документ',exact:true}).click();
  await expect(page.getByRole('heading',{level:1})).toHaveText('QA copy crossbrowser 24 (копия)');
  const rows=await documents(page,false,true);
  expect(rows).toHaveLength(2);
  expect(rows.find(d=>d.id===before.id)).toEqual(before);
  const copy=rows.find(d=>d.id!==before.id)!;
  expect((copy as any).generalCheckedItemIds).toEqual(['general-keys']);
  expect(copy.rooms[0].photos[0].blob.sha256).toBe(before.rooms[0].photos[0].blob.sha256);
  expect(copy.rooms[0].photos[0].id).not.toBe(before.rooms[0].photos[0].id);
  await page.getByRole('button',{name:'Сформировать PDF',exact:true}).click();
  await expect(page.getByRole('link',{name:'Скачать PDF',exact:true})).toBeVisible({timeout:30000});
  expect(errors).toEqual([]);expect(external).toEqual([]);
});

test('critical crossbrowser: UI/photo/checklist/defect/autosave/reload/PDF',async({page,browserName},info)=>{
  const observer=await observeErrors(page);
  const external:string[]=[];
  page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).hostname!=='127.0.0.1')external.push(request.url());});
  const environment={engine:browserName,version:page.context().browser()!.version(),playwright:'1.65.1',project:info.project.name,userAgent:'',nativePreview:false};
  const stockBiDi=info.project.name==='firefox-installed-bidi-realkeys';
  const addressText=stockBiDi?'QA synthetic browser address 7':'QA браузер, синтетический адрес';
  const captionText=stockBiDi?'Synthetic photo caption 7':'Синтетическая подпись';
  const defectText=stockBiDi?'Synthetic defect 7':'Тестовый дефект';
  async function inputText(field:ReturnType<typeof page.getByLabel>,text:string){
    if(stockBiDi){
      // BiDi insertText for non-ASCII text bypasses React's value tracker.
      // This stock-browser transport differential deliberately uses only native ASCII keys.
      await field.fill('');await field.pressSequentially(text.slice(0,-1));await field.press(text.slice(-1));
    }else await field.fill(text);
    await expect(field).toHaveValue(text);
  }
  if(stockBiDi){
    await page.goto('/');await page.getByRole('button',{name:/новый документ/i}).click();await setInspectionDate(page,'2026-02-03');
    await inputText(page.getByLabel(/^адрес/i),addressText);await page.keyboard.press('Tab');
    await expect.poll(async()=>(await documents(page)).some(doc=>doc.address===addressText)).toBe(true);
  }else await createDocument(page,addressText);
  environment.userAgent=await page.evaluate(()=>navigator.userAgent);
  await addRoom(page);
  await page.getByRole('button',{name:/Проверено/}).click();await page.getByRole('checkbox').first().check();
  await page.getByRole('button',{name:/Что проверить/}).click();await page.getByRole('button',{name:/К осмотру/}).click();
  expect((await onlyDoc(page)).rooms[0]!.checkedItemIds).toHaveLength(1);
  await expect(page.getByRole('button',{name:/Проверено 1 из 6/})).toBeVisible();
  await upload(page,[await syntheticPhoto(page,320,240)]);
  await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.photos.length).toBe(1);
  await page.getByRole('button',{name:'Открыть фото 1',exact:true}).click();
  await inputText(page.getByLabel('Подпись к фото'),captionText);
  await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.photos[0]!.caption).toBe(captionText);await page.keyboard.press('Escape');
  await page.getByRole('button',{name: /^Добавить(?: дефект)?$/,exact:true}).click();await inputText(page.getByLabel('Название дефекта'),defectText);
  await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.defects.length).toBe(1);
  await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.defects[0]!.title).toBe(defectText);
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  const before=await onlyDoc(page,false,true);expect(before.rooms[0]!.photos[0]!.blob.sha256).toMatch(/^[a-f0-9]{64}$/);
  await page.reload();await reopenRoom(page);expect(await onlyDoc(page,false,true)).toEqual(before);
  const geometry:{viewport:{width:number;height:number};rect:{top:number;bottom:number;barTop:number;hit:boolean}}[]=[];
  for(const viewport of [{width:430,height:887},{width:360,height:640},{width:1366,height:768}]){
    await page.setViewportSize(viewport);await noOverflow(page);
    const opener=page.getByRole('button',{name:'Действия',exact:true});await opener.focus();await page.keyboard.press('Enter');
    await page.getByRole('dialog',{name:'Действия',exact:true}).getByRole('button',{name:'Название и тип комнаты',exact:true}).click();
    await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(opener).toBeFocused();
    const photo=page.getByRole('button',{name:`Открыть фото ${captionText}`,exact:true});await photo.focus();await page.keyboard.press('Enter');
    await expect(page.getByLabel('Подпись к фото')).toBeVisible();await page.keyboard.press('Escape');await expect(photo).toBeFocused();
    await photo.evaluate(el=>el.scrollIntoView({block:'center'}));
    const rect=await photo.evaluate(el=>{const r=el.getBoundingClientRect(),bar=document.querySelector('.action-bar')!.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return{top:r.top,bottom:r.bottom,barTop:bar.top,hit:!!hit&&(el.contains(hit)||hit.contains(el))};});
    expect(rect.top).toBeGreaterThanOrEqual(0);expect(rect.bottom).toBeLessThanOrEqual(rect.barTop);expect(rect.hit).toBe(true);geometry.push({viewport,rect});
    await observer.capture('screenshot',()=>evidence(page,info,`crossbrowser-${info.project.name}-${viewport.width}`,{environment,geometry}));
  }
  await page.getByRole('button',{name:'К документу',exact:true}).click();await page.getByRole('button',{name:/Сформировать PDF/}).click();
  const link=page.getByRole('link',{name:'Скачать PDF'});await expect(link).toBeVisible();await expect(page.locator('iframe.pdf-preview')).toBeVisible();
  environment.nativePreview=await page.evaluate(()=>navigator.pdfViewerEnabled);
  const download=page.waitForEvent('download');await link.click();await mkdir('docs/evidence/qa',{recursive:true});
  const file=`docs/evidence/qa/crossbrowser-${info.project.name}.pdf`;await(await download).saveAs(file);
  const module='pdfjs-dist/legacy/build/pdf.mjs',pdfjs=await import(module),pdf=await pdfjs.getDocument({data:new Uint8Array(await readFile(file))}).promise;
  let text='',images=0;
  for(let n=1;n<=pdf.numPages;n++){const current=await pdf.getPage(n);text+=(await current.getTextContent()).items.map((item:{str?:string})=>item.str||'').join(' ')+' ';const ops=await current.getOperatorList();images+=ops.fnArray.filter((op:number)=>[pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintJpegXObject,pdfjs.OPS.paintInlineImageXObject].includes(op)).length;}
  expect(text).toContain(addressText);expect(text).toContain(defectText);expect(text).toContain(captionText);expect(images).toBe(1);expect(text.match(/Дата осмотра:/g)).toHaveLength(1);expect(text).toContain('03.02.2026');expect(text).not.toContain('Вернуться на сайт');
  expect(await onlyDoc(page,false,true)).toEqual(before);expect(external).toEqual([]);
  const bytes=(await stat(file)).size;
  // The ready card precedes the native viewer. Open it as a user would before
  // capturing the plugin, which can remain unpainted while below the viewport.
  await page.getByRole('button',{name:'Просмотреть PDF',exact:true}).click();
  await expect(page.locator('iframe.pdf-preview')).toBeInViewport();
  await completeErrorEvidence({
    capture:()=>observer.capture('screenshot',()=>evidence(page,info,`crossbrowser-${info.project.name}-pdf`,{environment,pages:pdf.numPages,bytes,images,text,idbIdentity:true,external,geometry},15000)),
    dispose:()=>pdf.destroy(),
    finish:()=>observer.finish(),
    persist:async snapshot=>{
      const errorsFile=`docs/evidence/qa/crossbrowser-${info.project.name}-final-errors.json`;
      await writeFile(errorsFile,JSON.stringify({environment,snapshot},null,2),'utf8');
      await info.attach('final-errors',{path:errorsFile,contentType:'application/json'});
    },
  });
});
