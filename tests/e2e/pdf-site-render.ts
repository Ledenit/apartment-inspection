import {expect,type Page,type TestInfo} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';

export type DecodedSiteQR={page:number;data:string;rect:number[]};

// Decode pixels rendered independently from the actual downloaded PDF; never import the product QR encoder.
export async function decodeRenderedSiteQR(owner:Page,info:TestInfo,file:string,key:string,pageCount:number):Promise<DecodedSiteQR[]>{
  const context=await owner.context().browser()!.newContext({viewport:{width:1900,height:2700}});
  try{
    const page=await context.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/__qa_site_pdfjs.mjs',async route=>route.fulfill({contentType:'text/javascript',body:await readFile('node_modules/pdfjs-dist/build/pdf.mjs')}));
    await page.route('**/__qa_site_worker.mjs',async route=>route.fulfill({contentType:'text/javascript',body:await readFile('node_modules/pdfjs-dist/build/pdf.worker.mjs')}));
    await page.route('**/__qa_site_jsqr.js',async route=>route.fulfill({contentType:'text/javascript',body:await readFile('node_modules/jsqr/dist/jsQR.js')}));
    await page.route('**/__qa_site_document.pdf',async route=>route.fulfill({contentType:'application/pdf',body:await readFile(file)}));
    await page.route('**/__qa_site_render__',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body style="margin:0;background:white"><script src="/__qa_site_jsqr.js"></script><script type="module">
      import * as pdfjs from '/__qa_site_pdfjs.mjs';
      pdfjs.GlobalWorkerOptions.workerSrc='/__qa_site_worker.mjs';
      const pdf=await pdfjs.getDocument('/__qa_site_document.pdf').promise;
      const found=[];
      for(let n=1;n<=pdf.numPages;n++){
        const page=await pdf.getPage(n),viewport=page.getViewport({scale:3});
        const canvas=document.createElement('canvas');canvas.dataset.page=String(n);canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);document.body.append(canvas);
        const ctx=canvas.getContext('2d',{willReadFrequently:true});await page.render({canvasContext:ctx,viewport}).promise;
        const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
        // At most two detections suffice to reject a duplicated footer QR. Mask only the decode buffer, preserve screenshot pixels.
        for(let attempt=0;attempt<2;attempt++){
          const code=window.jsQR(pixels.data,canvas.width,canvas.height,{inversionAttempts:'attemptBoth'});if(!code)break;
          const corners=[code.location.topLeftCorner,code.location.topRightCorner,code.location.bottomRightCorner,code.location.bottomLeftCorner];
          const points=corners.map(point=>viewport.convertToPdfPoint(point.x,point.y));
          found.push({page:n,data:code.data,rect:[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))]});
          const left=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.x)))-4),right=Math.min(canvas.width,Math.ceil(Math.max(...corners.map(p=>p.x)))+4);
          const top=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.y)))-4),bottom=Math.min(canvas.height,Math.ceil(Math.max(...corners.map(p=>p.y)))+4);
          for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){const offset=(y*canvas.width+x)*4;pixels.data[offset]=pixels.data[offset+1]=pixels.data[offset+2]=pixels.data[offset+3]=255;}
        }
      }
      window.__qaSiteDecoded=found;
      </script></body></html>`}));
    await page.goto('http://127.0.0.1:4173/__qa_site_render__');
    await page.waitForFunction(()=>Array.isArray((window as unknown as {__qaSiteDecoded?:unknown}).__qaSiteDecoded),{},{timeout:30_000});
    expect(errors).toEqual([]);await mkdir('docs/evidence/qa',{recursive:true});
    for(let n=1;n<=pageCount;n++)await page.locator(`canvas[data-page="${n}"]`).screenshot({path:`docs/evidence/qa/pdf-site-${key}-page-${n}.png`});
    const decoded=await page.evaluate(()=>(window as unknown as {__qaSiteDecoded:DecodedSiteQR[]}).__qaSiteDecoded);
    const artifact=`docs/evidence/qa/pdf-site-${key}-decoded.json`;await writeFile(artifact,JSON.stringify(decoded,null,2),'utf8');await info.attach('decoded-actual-pdf-qr',{path:artifact,contentType:'application/json'});
    return decoded;
  }finally{await context.close();}
}
