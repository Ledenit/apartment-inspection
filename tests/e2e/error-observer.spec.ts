import {test,expect} from './demo-fixture';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {observeErrors,completeErrorEvidence,assertNoUnexpectedErrors,SCREENSHOT_STYLE_HASH,type finalizeErrors} from './error-observer';

test('R9: actual late capture errors remain in immutable persisted and attached snapshot; forged CSP fails closed',async({page},info)=>{
  test.setTimeout(30_000);
  await page.route('**/__qa_error_observer__',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><title>QA synthetic observer</title></head><body><h1>QA synthetic observer</h1></body></html>'}));
  const observer=await observeErrors(page);await page.goto('/__qa_error_observer__');
  const order:string[]=[],markers=['QA late error during awaited capture',`QA forged inline CSP sha256-${SCREENSHOT_STYLE_HASH}`];
  let assertedSnapshot:ReturnType<typeof finalizeErrors>|undefined;
  const directory='docs/evidence/qa/r9-amended';await mkdir(directory,{recursive:true});
  const artifact=`${directory}/late-errors.json`;
  await expect(completeErrorEvidence({
    capture:()=>observer.capture('screenshot',async()=>{
      order.push('capture-start');
      const first=page.waitForEvent('pageerror',{predicate:error=>error.message===markers[0]}),second=page.waitForEvent('pageerror',{predicate:error=>error.message===markers[1]});
      await page.evaluate(({markers})=>{
        setTimeout(()=>{throw new Error(markers[0]);},15);
        setTimeout(()=>{const error=new Error(markers[1]);error.name='Content-Security-Policy';throw error;},25);
      },{markers});
      await page.screenshot({path:`${directory}/awaited-capture.png`});
      await Promise.all([first,second]);order.push('capture-end');
    }),
    dispose:async()=>{order.push('dispose');},
    finish:async()=>{order.push('finish-start');const value=await observer.finish();order.push('finish-end');return value;},
    persist:async snapshot=>{
      order.push('persist-start');assertedSnapshot=snapshot;
      await writeFile(artifact,JSON.stringify(snapshot,null,2),'utf8');
      await info.attach('r9-late-errors',{path:artifact,contentType:'application/json'});order.push('persist-end');
    },
  })).rejects.toThrow('Unexpected browser diagnostics: 2 page errors, 0 CSP violations, 2 window errors');
  expect(order).toEqual(['capture-start','capture-end','dispose','finish-start','finish-end','persist-start','persist-end']);
  const snapshot=assertedSnapshot!;
  expect(snapshot.errors.map(error=>error.message).sort()).toEqual([...markers].sort());
  expect(snapshot.windowErrors).toHaveLength(2);expect(snapshot.witnesses).toHaveLength(0);
  expect(snapshot.classifiedArtifacts).toHaveLength(0);expect(snapshot.unexpectedErrors).toHaveLength(2);
  expect(snapshot.errors.every(error=>error.capture===1)).toBe(true);
  expect(snapshot.errors.find(error=>error.message===markers[1])!.name).toBe('Content-Security-Policy');
  for(const value of [snapshot,snapshot.errors,snapshot.errors[0]!,snapshot.windowErrors,snapshot.unexpectedErrors])expect(Object.isFrozen(value)).toBe(true);
  const persisted=await readFile(artifact),attachment=info.attachments.find(value=>value.name==='r9-late-errors');
  expect(attachment?.path).toBeTruthy();const attached=await readFile(attachment!.path!);
  expect(JSON.parse(persisted.toString('utf8'))).toEqual(snapshot);expect(attached.equals(persisted)).toBe(true);
  expect(()=>assertNoUnexpectedErrors(snapshot)).toThrow('Unexpected browser diagnostics');
  const serialize=Buffer.from(JSON.stringify(snapshot,null,2)),hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  expect(hash(serialize)).toBe(hash(persisted));expect(hash(attached)).toBe(hash(persisted));
  await writeFile(`${directory}/consistency.json`,JSON.stringify({order,snapshotSHA256:hash(serialize),diskSHA256:hash(persisted),attachmentSHA256:hash(attached),rawErrors:snapshot.errors.length,rawWindowErrors:snapshot.windowErrors.length,classified:0,unexpected:2,immutable:true,validationRejected:true},null,2),'utf8');
});

for(const scope of ['application','outsideApplication'] as const){
  test(`R9: actual Page identity ${scope} with identical URL and error text`,async({page,context},info)=>{
    test.setTimeout(30_000);
    await context.route('**/__qa_identity__',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><h1>QA identical URL</h1></body></html>'}));
    const observer=await observeErrors(page);await page.goto('/__qa_identity__');
    const other=await context.newPage();await other.goto(page.url());expect(other.url()).toBe(page.url());
    const target=scope==='application'?page:other,marker='QA identical message for host identity';
    const event=target.waitForEvent('pageerror',{predicate:error=>error.message===marker});
    await observer.capture('screenshot',async()=>{
      await target.evaluate(marker=>{setTimeout(()=>{throw new Error(marker);},15);},marker);
      await page.screenshot();await event;
    });
    const snapshot=await observer.finish();
    expect(snapshot.errors).toHaveLength(1);expect(snapshot.windowErrors).toHaveLength(1);
    expect(snapshot.errors[0]!.message).toBe(marker);expect(snapshot.errors[0]!.pageURL).toBe(page.url());
    expect(snapshot.errors[0]!.scope).toBe(scope);expect(snapshot.errors[0]!.source).toBe('playwright-page-identity');
    expect(snapshot.windowErrors[0]!.scope).toBe(scope);
    expect(snapshot.classifiedArtifacts).toHaveLength(0);
    const expectedUnexpected=scope==='application'?1:0;
    expect(snapshot.unexpectedErrors).toHaveLength(expectedUnexpected);expect(snapshot.unexpectedWindowErrors).toHaveLength(expectedUnexpected);
    if(scope==='application'){
      expect(snapshot.errors[0]!.hostPageId).toBe(snapshot.applicationPageId);
      expect(()=>assertNoUnexpectedErrors(snapshot)).toThrow('Unexpected browser diagnostics: 1 page errors, 0 CSP violations, 1 window errors');
      expect(snapshot.outsideApplication.errors).toHaveLength(0);
    }else{
      expect(snapshot.errors[0]!.hostPageId).not.toBe(snapshot.applicationPageId);
      expect(snapshot.outsideApplication.attribution).toBe('UNKNOWN');
      expect(snapshot.outsideApplication.errors).toEqual(snapshot.errors);expect(snapshot.outsideApplication.windowErrors).toEqual(snapshot.windowErrors);
      expect(()=>assertNoUnexpectedErrors(snapshot)).not.toThrow();
    }
    const directory='docs/evidence/qa/r9-amended';await mkdir(directory,{recursive:true});const file=`${directory}/identity-${scope}.json`;
    const bytes=Buffer.from(JSON.stringify(snapshot,null,2));await writeFile(file,bytes);await info.attach(`identity-${scope}`,{path:file,contentType:'application/json'});
    const attachment=info.attachments.find(item=>item.name===`identity-${scope}`)!;
    expect((await readFile(attachment.path!)).equals(bytes)).toBe(true);expect(JSON.parse((await readFile(file)).toString())).toEqual(snapshot);
    await other.close();
  });
}
