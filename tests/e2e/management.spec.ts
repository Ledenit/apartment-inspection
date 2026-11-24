import {test,expect,type Page} from './demo-fixture';
import {readFile} from 'node:fs/promises';
import {createDocument,addRoom,openRoom,onlyDoc,documents,upload,syntheticPhoto,finishDialog,evidence} from './helpers';

async function actions(page:Page,name:string){await page.getByRole('button',{name:'Действия',exact:true}).click();await page.getByRole('dialog',{name:'Действия',exact:true}).getByRole('button',{name,exact:true}).click();}
async function deletion(page:Page,kind:string,title:string,cancel:boolean){
  await actions(page,`Удалить ${kind}`);
  const dialog=page.getByRole('dialog');await expect(dialog).toHaveAccessibleName(`Удалить «${title}»?`);
  await expect(dialog).toContainText(/нельзя отменить/);
  await dialog.getByRole('button',{name:cancel?'Продолжить редактирование':'Удалить',exact:true}).click();
}

test('M01: документ rename/delete cancel/confirm, новые сверху, cascade reload',async({page},info)=>{
  await createDocument(page,'QA первый адрес');await addRoom(page);
  await upload(page,[await syntheticPhoto(page,80,60)]);
  await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.photos.length).toBe(1);
  await page.getByRole('button',{name: /^Добавить(?: дефект)?$/,exact:true}).click();await page.getByLabel('Название дефекта').fill('Дефект каскада');
  await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.defects.length).toBe(1);
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.getByRole('button',{name:'К документу',exact:true}).click();
  const id=(await onlyDoc(page)).id;
  await actions(page,'Изменить данные документа');await page.getByLabel('Название документа').fill('Переименованный документ');await finishDialog(page);
  await expect.poll(async()=>(await onlyDoc(page)).title).toBe('Переименованный документ');expect((await onlyDoc(page)).id).toBe(id);
  await deletion(page,'документ','Переименованный документ',true);expect((await onlyDoc(page)).rooms[0]!.defects).toHaveLength(1);
  await page.getByRole('button',{name:'В библиотеку',exact:true}).click();await createDocument(page,'QA второй адрес');
  await page.getByRole('button',{name:'В библиотеку',exact:true}).click();
  await expect(page.locator('.list-row').first()).toContainText('QA второй адрес');
  const second=(await documents(page)).find(doc=>doc.address==='QA второй адрес')!;
  await page.locator('.list-row').filter({hasText:'Переименованный документ'}).click();
  await deletion(page,'документ','Переименованный документ',false);
  await expect.poll(async()=>(await documents(page)).map(doc=>doc.id)).toEqual([second.id]);
  await page.reload();expect((await documents(page)).map(doc=>doc.id)).toEqual([second.id]);
  await expect(page.locator('.list-row')).toHaveCount(1);await expect(page.locator('.list-row')).toContainText('QA второй адрес');
  await evidence(page,info,'v3-management-document',{removedDocument:id,survivor:second.id,cascadeRoomPhotoDefect:true});
});

test('M02: custom/suffix, room rename/delete cascade, дефект rename/delete cancel/confirm',async({page},info)=>{
  await createDocument(page);await addRoom(page);await page.getByRole('button',{name:'К документу',exact:true}).click();
  await addRoom(page);await page.getByRole('button',{name:'К документу',exact:true}).click();await addRoom(page);
  expect((await onlyDoc(page)).rooms.map(room=>room.name)).toEqual(['Комната','Комната 2','Комната 3']);
  await page.getByRole('button',{name:'К документу',exact:true}).click();
  await page.getByRole('button',{name: /^Добавить(?: дефект)?$/,exact:true}).click();
  await page.getByLabel('Своё название').fill('Кладовая');
  await page.getByRole('dialog').getByRole('button',{name: /^Добавить(?: дефект)?$/,exact:true}).click();
  await expect.poll(async()=>(await onlyDoc(page)).rooms.length).toBe(4);
  const custom=(await onlyDoc(page)).rooms[3]!;expect(custom.type).toBe('Комната');expect(custom.name).toBe('Кладовая');
  await actions(page,'Название и тип комнаты');await page.getByLabel('Название комнаты').fill('Кладовая переименована');await finishDialog(page);
  await expect.poll(async()=>(await onlyDoc(page)).rooms[3]!.name).toBe('Кладовая переименована');expect((await onlyDoc(page)).rooms[3]!.id).toBe(custom.id);
  const image=await syntheticPhoto(page,80,60);
  await upload(page,[image]);await expect.poll(async()=>(await onlyDoc(page)).rooms[3]!.photos.length).toBe(1);
  await page.getByRole('button',{name: /^Добавить(?: дефект)?$/,exact:true}).click();await page.getByLabel('Название дефекта').fill('Первый дефект');
  await expect.poll(async()=>(await onlyDoc(page)).rooms[3]!.defects.length).toBe(1);
  await upload(page,[image]);await expect.poll(async()=>(await onlyDoc(page)).rooms[3]!.defects[0]!.photos.length).toBe(1);
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.locator('.list-row').filter({hasText:'Первый дефект'}).click();
  const defectId=(await onlyDoc(page)).rooms[3]!.defects[0]!.id;
  await actions(page,'Название дефекта');await page.getByLabel('Название дефекта').fill('Переименованный дефект');await finishDialog(page);
  await expect.poll(async()=>(await onlyDoc(page)).rooms[3]!.defects[0]!.title).toBe('Переименованный дефект');
  expect((await onlyDoc(page)).rooms[3]!.defects[0]!.id).toBe(defectId);
  await deletion(page,'дефект','Переименованный дефект',true);expect((await onlyDoc(page)).rooms[3]!.defects).toHaveLength(1);
  await deletion(page,'дефект','Переименованный дефект',false);await expect.poll(async()=>(await onlyDoc(page)).rooms[3]!.defects.length).toBe(0);
  // Add a second child, then delete its parent to prove nested cascade independently of document deletion.
  await page.getByRole('button',{name: /^Добавить(?: дефект)?$/,exact:true}).click();await page.getByLabel('Название дефекта').fill('Каскадный дефект');
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await deletion(page,'комнату','Кладовая переименована',true);expect((await onlyDoc(page)).rooms).toHaveLength(4);
  await deletion(page,'комнату','Кладовая переименована',false);await expect.poll(async()=>(await onlyDoc(page)).rooms.length).toBe(3);
  const remaining=(await onlyDoc(page)).rooms;expect(remaining.map(room=>room.name)).toEqual(['Комната','Комната 2','Комната 3']);
  await page.reload();expect((await onlyDoc(page)).rooms).toEqual(remaining);
  await page.locator('.list-row').first().click();await openRoom(page,'Комната 2');
  await deletion(page,'комнату','Комната 2',false);await expect.poll(async()=>(await onlyDoc(page)).rooms.length).toBe(2);
  const survivors=(await onlyDoc(page)).rooms;
  await addRoom(page);const afterAdd=(await onlyDoc(page)).rooms;
  expect(afterAdd.slice(0,2)).toEqual(survivors);expect(new Set(afterAdd.map(room=>room.name)).size).toBe(3);expect(afterAdd[2]!.name).toMatch(/^Комната \d+$/);
  await evidence(page,info,'v3-management-room-defect',{customType:'Комната',customRemoved:custom.id,defectRemoved:defectId,remainingIds:afterAdd.map(room=>room.id),suffixAfterGap:afterAdd[2]!.name});
});

test('M03: checklist0/6 alltypes, help не пишет, typechange cancel/confirm, reload',async({page},info)=>{
  const expected=JSON.parse(await readFile('src/checklists.json','utf8')) as Record<string,{id:string;title:string;hint:string}[]>;
  await createDocument(page);
  for(const[type,items]of Object.entries(expected)){
    await addRoom(page,type);const roomId=(await onlyDoc(page)).rooms.at(-1)!.id;
    const progress=page.getByRole('button',{name:/Проверено.*из 6/});await expect(progress).toContainText('Проверено 0 из 6');await progress.click();
    await expect(page.getByRole('checkbox')).toHaveCount(6);
    await page.getByRole('checkbox',{name:items[0]!.title,exact:true}).check();await expect(progress).toContainText('Проверено 1 из 6');
    for(const item of items.slice(1))await page.getByRole('checkbox',{name:item.title,exact:true}).check();
    await expect.poll(async()=>(await onlyDoc(page)).rooms.find(room=>room.id===roomId)!.checkedItemIds.slice().sort()).toEqual(items.map(item=>item.id).sort());
    await expect(progress).toContainText('Проверено 6 из 6');await progress.click();await progress.click();
    for(const item of items)await expect(page.getByRole('checkbox',{name:item.title,exact:true})).toBeChecked();
    const beforeHelp=await onlyDoc(page);
    await page.getByRole('button',{name:/Что проверить/}).click();
    for(const item of items){const toggle=page.getByRole('button',{name:item.title,exact:true});if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();await expect(page.getByText(item.hint,{exact:true})).toBeVisible();}
    await page.getByRole('button',{name:/К осмотру/}).click();expect(await onlyDoc(page)).toEqual(beforeHelp);
    await page.getByRole('button',{name:'К документу',exact:true}).click();
  }
  await openRoom(page,'Комната');const original=(await onlyDoc(page)).rooms.find(room=>room.type==='Комната')!;
  await actions(page,'Название и тип комнаты');await page.getByLabel('Тип комнаты').selectOption('Кухня');
  await page.getByRole('dialog',{name:'Изменить тип комнаты?',exact:true}).getByRole('button',{name:'Продолжить редактирование',exact:true}).click();
  expect((await onlyDoc(page)).rooms.find(room=>room.id===original.id)).toEqual(original);
  await page.getByLabel('Тип комнаты').selectOption('Кухня');await page.getByRole('dialog',{name:'Изменить тип комнаты?',exact:true}).getByRole('button',{name:'Подтвердить',exact:true}).click();
  await finishDialog(page);await expect.poll(async()=>(await onlyDoc(page)).rooms.find(room=>room.id===original.id)!.type).toBe('Кухня');
  expect((await onlyDoc(page)).rooms.find(room=>room.id===original.id)!.checkedItemIds).toEqual([]);
  const saved=await onlyDoc(page);await page.reload();expect(await onlyDoc(page)).toEqual(saved);
  await evidence(page,info,'v3-management-checklists',{types:6,items:36,allCheckedBeforeTypeChange:true,typeChangeClearedOnlyAfterConfirmation:true});
});
