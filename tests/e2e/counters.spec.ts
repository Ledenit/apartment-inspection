import {test,expect} from './demo-fixture';
import {createDocument,addRoom,onlyDoc,syntheticPhoto,upload,evidence} from './helpers';

test('M04: валидные isolated IDB fixtures — русские формы и фактические счётчики',async({page},info)=>{
  await createDocument(page);await addRoom(page);await upload(page,[await syntheticPhoto(page,80,60)]);
  await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.photos.length).toBe(1);
  await page.getByRole('button',{name: /^Добавить(?: дефект)?$/,exact:true}).click();await page.getByLabel('Название дефекта').fill('Шаблон счётчика');
  await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.defects.length).toBe(1);
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  const id=(await onlyDoc(page)).id;
  const template=await onlyDoc(page,true);
  // Explicit linguistic oracle, independent of the product inflection function.
  const forms=[
    {n:0,rooms:/(?:нет комнат|0 комнат)/,defects:/(?:нет дефектов|0 дефектов)/},
    {n:1,rooms:/1 комната/,defects:/1 дефект(?:\s|$)/},
    {n:2,rooms:/2 комнаты/,defects:/2 дефекта/},
    {n:5,rooms:/5 комнат/,defects:/5 дефектов/},
    {n:11,rooms:/11 комнат/,defects:/11 дефектов/},
    {n:14,rooms:/14 комнат/,defects:/14 дефектов/},
    {n:21,rooms:/21 комната/,defects:/21 дефект(?:\s|$)/},
  ];
  const observed=[];
  for(const row of forms){
    await page.evaluate(async({id,n,template})=>{
      for(const database of await indexedDB.databases()){
        if(!database.name)continue;
        const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(database.name!);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
        try{for(const storeName of Array.from(db.objectStoreNames)){
          const original=await new Promise<any>((resolve,reject)=>{const request=db.transaction(storeName).objectStore(storeName).get(id);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
          if(!original?.rooms)continue;
          const room=template.rooms[0]!,defect=room.defects[0]!;
          const sourcePhoto=room.photos[0]!;
          const photo={...sourcePhoto,blob:new Blob([new Uint8Array(sourcePhoto.blob.bytes)],{type:'image/jpeg'})};
          const next=structuredClone(original);
          next.rooms=Array.from({length:n},(_,index)=>({...structuredClone(room),id:crypto.randomUUID(),name:`Комната ${index+1}`,checkedItemIds:[],photos:index===0?Array.from({length:Math.min(n,14)},()=>({...structuredClone(photo),id:crypto.randomUUID()})):[],defects:index===0?Array.from({length:n},(_,index)=>({...structuredClone(defect),id:crypto.randomUUID(),title:`Дефект ${index+1}`,photos:[]})):[]}));
          next.revision+=1;next.updatedAt=typeof original.updatedAt==='string'?new Date().toISOString():Date.now();
          await new Promise<void>((resolve,reject)=>{const tx=db.transaction(storeName,'readwrite');tx.objectStore(storeName).put(next);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
        }}finally{db.close();}
      }
    },{id,n:row.n,template});
    await page.reload();
    const stored=await onlyDoc(page);expect(stored.rooms).toHaveLength(row.n);expect(stored.rooms.reduce((sum,room)=>sum+room.defects.length,0)).toBe(row.n);
    const libraryRow=page.locator('.list-row');await expect(libraryRow).toContainText(row.rooms);await expect(libraryRow).toContainText(row.defects);await libraryRow.click();
    if(row.n===0){await expect(page.getByText('Нет добавленных комнат',{exact:true})).toBeVisible();}
    else{
      await expect(page.locator('.section-heading').filter({has:page.getByRole('heading',{name:/Комнаты/})}).locator('.badge')).toHaveText(String(row.n));
      const roomRow=page.locator('.list-row').first();await expect(roomRow).toContainText(`${Math.min(row.n,14)} фото`);await expect(roomRow).toContainText(row.defects);await roomRow.click();
      await expect(page.locator('.summary')).toContainText(`${Math.min(row.n,14)} фото`);await expect(page.locator('.summary')).toContainText(row.defects);
      await expect(page.locator('.section-heading').filter({has:page.getByRole('heading',{name:/Дефекты/})}).locator('.badge')).toHaveText(String(row.n));
    }
    observed.push({rooms:row.n,defects:row.n,photos:Math.min(row.n,14),fixture:'direct isolated origin IDB, valid limits'});
  }
  await evidence(page,info,'v3-management-counter-forms',{observed,photo21:'not applicable: max15 room /6 defect; no invalid fixture'});
});
