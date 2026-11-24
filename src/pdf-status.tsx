import { useRef } from "react";
import { Button, Icon } from "./ui";
import type { PdfStage } from "./pdf";

export function PdfStatus({ ready, stage = 0 }: { ready: boolean; stage?: PdfStage }) {
  const step = ready ? 6 : stage;
  const card = useRef<HTMLDivElement>(null);
  return (
    <div className="pdf-status-card" ref={card} role={ready ? undefined : "status"} data-stage={step}>
      <div className="pdf-status-art" aria-hidden="true">
        {step >= 1 && (
          <svg width="160" height="176" viewBox="94 28 150 180" fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M109 45H194L219 70V195Q219 203 211 203H109Q101 203 101 195V53Q101 45 109 45Z" fill="white" />
            <path d="M194 45V64Q194 70 200 70H219" />
            {step >= 2 && <><path d="M118 84H180" strokeWidth="4" /><path d="M118 94H159" stroke="#5e5e5e" /></>}
            {step >= 3 && <>
            <rect x="117" y="111" width="38" height="38" rx="6" fill="#e8e8e8" />
            <circle cx="128" cy="122" r="3" />
            <path d="M122 142L132 132L138 138L144 129L150 137" />
            </>}
            {step >= 4 && <>
            <rect x="165" y="111" width="38" height="38" rx="6" fill="#e8e8e8" />
            <path d="M172 124V118H178M190 118H196V124M196 136V142H190M178 142H172V136M188 123L182 129L186 132L180 138" />
            </>}
            {step >= 5 && <>
            <path d="M128 166H202M128 178H190M128 190H174" stroke="#5e5e5e" />
            <circle cx="119" cy="166" r="1" /><circle cx="119" cy="178" r="1" /><circle cx="119" cy="190" r="1" />
            </>}
            {ready && <>
            <circle cx="218" cy="52" r="20" fill="#33b2f4" stroke="none" />
            <path d="M208 52L215 59L228 46" strokeWidth="3" />
            </>}
          </svg>
        )}
      </div>
      <h2>{ready ? "Документ готов" : "Формируем документ"}</h2>
      <p>{ready ? "PDF готов к просмотру" : "Собираем фото и записи"}</p>
      {ready ? (
        <Button onClick={() => {
          const preview = card.current?.parentElement?.querySelector<HTMLIFrameElement>("iframe.pdf-preview");
          preview?.focus();
          preview?.scrollIntoView({ block: "start", behavior: "auto" });
        }}>
          <Icon name="plus" />Просмотреть PDF
        </Button>
      ) : <p>Предпросмотр станет доступен после сборки</p>}
    </div>
  );
}
