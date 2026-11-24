import {expect,type Page,type TestInfo} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';

// Test-only renderer: local package/PDF routes in a fresh context, never a product module.
export async function renderPdfFirstPage(owner:Page,info:TestInfo,file:string):Promise<void>{
  const context=await owner.context().browser()!.newContext({viewport:{width:1000,height:1400}});
  try{
    const page=await context.newPage();
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/__qa_pdfjs/pdf.mjs',async route=>route.fulfill({contentType:'text/javascript',body:await readFile('node_modules/pdfjs-dist/build/pdf.mjs')}));
    await page.route('**/__qa_pdfjs/pdf.worker.mjs',async route=>route.fulfill({contentType:'text/javascript',body:await readFile('node_modules/pdfjs-dist/build/pdf.worker.mjs')}));
    await page.route('**/__qa_document.pdf',async route=>route.fulfill({contentType:'application/pdf',body:await readFile(file)}));
    await page.route('**/__qa_pdf_render__',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body style="margin:0;background:white"><canvas id="first"></canvas><script type="module">
      import * as pdfjs from '/__qa_pdfjs/pdf.mjs';
      pdfjs.GlobalWorkerOptions.workerSrc='/__qa_pdfjs/pdf.worker.mjs';
      const pdf=await pdfjs.getDocument('/__qa_document.pdf').promise;
      const page=await pdf.getPage(1),viewport=page.getViewport({scale:1.5});
      const canvas=document.querySelector('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      window.__qaRendered={width:canvas.width,height:canvas.height,pages:pdf.numPages,scale:1.5};
      </script></body></html>`}));
    await page.goto('http://127.0.0.1:4173/__qa_pdf_render__');
    await page.waitForFunction(()=>Boolean((window as unknown as {__qaRendered?:unknown}).__qaRendered),{},{timeout:15_000});
    expect(errors).toEqual([]);
    await mkdir('docs/evidence/qa',{recursive:true});
    const png='docs/evidence/qa/v4-pdf30-rendered-first-page.png';
    await page.locator('canvas').screenshot({path:png});
    await info.attach('pdf30-rendered-first-page',{path:png,contentType:'image/png'});
  }finally{await context.close();}
}
