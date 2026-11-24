import {test,expect} from './demo-fixture';
import {stat,readFile,mkdir} from 'node:fs/promises';
import {createDocument,addRoom,onlyDoc,evidence} from './helpers';

test('V2: dist preview business PDF smoke',async({page},info)=>{
  test.skip(!process.env.QA_PREVIEW_BASE_URL, 'Requires explicitly running built dist preview');
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await createDocument(page,'QA dist preview, 4174');await addRoom(page);
  expect((await onlyDoc(page)).rooms).toHaveLength(1);
  await page.getByRole('button',{name:'К документу',exact:true}).click();
  await page.getByRole('button',{name:/Сформировать PDF/}).click();
  const event=page.waitForEvent('download');await page.getByRole('link',{name:'Скачать PDF'}).click();
  await mkdir('docs/evidence/qa',{recursive:true});
  const file='docs/evidence/qa/actual-dist-preview.pdf';await(await event).saveAs(file);
  const module='pdfjs-dist/legacy/build/pdf.mjs';const pdfjs=await import(module);
  const pdf=await pdfjs.getDocument({data:new Uint8Array(await readFile(file))}).promise;
  const texts=[];for(let n=1;n<=pdf.numPages;n++)texts.push((await(await pdf.getPage(n)).getTextContent()).items.map((i:{str?:string})=>i.str||'').join(' '));
  expect(texts.join(' ')).toContain('Осмотр квартиры');expect(texts.join(' ')).toContain('QA dist preview, 4174');await pdf.destroy();expect(errors).toEqual([]);
  await page.reload();
  await expect(page.locator('.list-row').filter({hasText:'QA dist preview, 4174'})).toBeVisible();
  await evidence(page,info,'v2-dist-preview',{url:page.url(),bytes:(await stat(file)).size,pageerrors:errors});
});
