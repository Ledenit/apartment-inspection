import { useId, useState } from "react";
import { getChecklist, type RoomType } from "./model";
import { Button, Icon } from "./ui";

export function Checklist({ type, checked, onChange, onHelp }: {
  type: RoomType;
  checked: string[];
  onChange: (items: string[]) => void;
  onHelp: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="checklist">
    <button className="check-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <Icon name="clipboard" />Проверено {checked.length} из 6 пунктов
      <span className={open ? "rotate-up" : "rotate-down"}><Icon name="chevron" /></span>
    </button>
    {open && <div id={id} className="check-items">
      {getChecklist(type).map(item => <div className="check-entry" key={item.id}>
        <label className="check-item">
          <input type="checkbox" checked={checked.includes(item.id)} onChange={e => onChange(e.target.checked ? [...checked, item.id] : checked.filter(id => id !== item.id))} />
          <span>{item.title}</span>
        </label>
        <p className="check-hint"><Icon name="camera" /><span>{item.hint}</span></p>
      </div>)}
      <Button kind="plain" onClick={onHelp}>Что проверить и как снять<Icon name="arrow" /></Button>
    </div>}
  </section>;
}
