import {test,expect} from './demo-fixture';
import {createDocument,addRoom,onlyDoc,syntheticPhoto,upload,openDescription,finishDialog,evidence} from './helpers';

test('V2: normal430 filled screens для независимой UX',async({page},info)=>{
  await createDocument(page,'Екатеринбург, ул. Бажова, 125');
  await page.getByLabel('Название документа').fill('Квартира на Бажова');
  await expect.poll(async()=>(await onlyDoc(page)).title).toBe('Квартира на Бажова');
  const inlineGeometry=await page.locator('.new-header').evaluate(header=>{
    const rect=(selector:string)=>{const node=header.querySelector<HTMLElement>(selector)!;const box=node.getBoundingClientRect();return {top:box.top,bottom:box.bottom,width:box.width,height:box.height};};
    return {title:rect('.title-row'),address:rect('.inline-address input'),date:rect('.date-button'),calendar:rect('.calendar-target'),description:rect('.description'),calendarIcons:header.querySelectorAll('.date-button svg').length,dateText:header.querySelector('.date-button')!.textContent};
  });
  expect(inlineGeometry.calendar.height).toBeGreaterThanOrEqual(44);expect(inlineGeometry.calendar.width).toBeGreaterThanOrEqual(44);
  expect(inlineGeometry.calendarIcons).toBe(1);expect(inlineGeometry.dateText).toContain('Дата осмотра:');
  await evidence(page,info,'v3-normal-inline',{locale:await page.evaluate(()=>navigator.language),inlineGeometry,acceptedException:'address underline +20px for separate44px touch target'});
  await addRoom(page);
  const field=await openDescription(page); await field.fill('Окна выходят на улицу, пол — ламинат.');await finishDialog(page);
  const image=await syntheticPhoto(page,320,240);
  async function caption(index:number,text:string){await page.getByRole('button',{name:`Открыть фото ${index}`,exact:true}).click();await page.getByLabel('Подпись к фото').fill(text);await page.keyboard.press('Escape');}
  await upload(page,[image]);await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.photos.length).toBe(1);
  await caption(1,'Вид комнаты со стороны входа');
  await page.getByRole('button',{name: /^Добавить(?: дефект)?$/,exact:true}).click();
  await page.getByLabel('Название дефекта').fill('Трещина над окном');
  await upload(page,[image,image]);await expect.poll(async()=>(await onlyDoc(page)).rooms[0]!.defects[0]!.photos.length).toBe(2);
  await caption(1,'Общий план трещины');await caption(2,'Крупный план');
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await evidence(page,info,'v3-normal-room',{});
  await page.locator('.list-row').filter({hasText:'Трещина над окном'}).click();
  await evidence(page,info,'v3-normal-existing-defect',{});
  await expect(page.getByLabel('Название дефекта')).toHaveCount(0);
  await page.getByRole('button',{name:'К комнате',exact:true}).click();
  await page.getByRole('button',{name:/Проверено/}).click();await page.getByRole('button',{name:/Что проверить/}).click();
  const helpGeometry=await page.locator('main').evaluate(main=>{
    const toggles=Array.from(main.querySelectorAll<HTMLElement>('.help-toggle')).map(node=>({expanded:node.getAttribute('aria-expanded'),height:node.getBoundingClientRect().height,gap:getComputedStyle(node).gap}));
    const label=main.querySelector('.help-select > span:first-child')!;
    const svg=main.querySelector('.help-select svg')?.getBoundingClientRect();
    return {toggles,labelLineHeight:getComputedStyle(label).lineHeight,chevron:svg?{width:svg.width,height:svg.height}:null};
  });
  expect(helpGeometry.toggles.find(row=>row.expanded==='true')!.height).toBe(56);
  for(const toggle of helpGeometry.toggles.filter(row=>row.expanded==='false'))expect(toggle.height).toBe(64);
  expect(helpGeometry.labelLineHeight).toBe('22px');expect(helpGeometry.chevron).toEqual({width:24,height:24});
  await evidence(page,info,'v3-normal-help',{helpGeometry});
  await page.getByRole('button',{name:/К осмотру/}).click();await page.getByRole('button',{name:'К документу',exact:true}).click();
  await evidence(page,info,'v3-normal-document',{});
  await page.getByRole('button',{name:'В библиотеку',exact:true}).click();await evidence(page,info,'v3-normal-library',{});
});
