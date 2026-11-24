import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "./photo-sync";
import { Button, Header } from "./ui";

export function DemoAccess({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false), [checking, setChecking] = useState(true);
  const [phone, setPhone] = useState("70000000000"), [code, setCode] = useState("0000");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    apiFetch("/api/session", { cache: "no-store" }).then(response => response.json()).then(data => {
      if (active) setReady(data.authenticated === true);
    }).catch(() => { if (active) setError("Сервис временно недоступен. Попробуйте войти ещё раз."); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);
  if (ready) return children;
  return <main className="app narrow demo-access">
    <Header title="Осмотр квартиры" />
    {checking ? <p role="status">Проверяем вход…</p> : <form className="stack" onSubmit={async event => {
      event.preventDefault(); if (submitting.current) return;
      submitting.current = true;
      setBusy(true); setError("");
      try {
        const response = await apiFetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, code }) });
        const data = await response.json();
        if (data.authenticated !== true) throw new Error();
        setReady(true);
      } catch { setError("Не получилось войти. Используйте тестовый номер 70000000000 и код 0000 либо повторите позже."); }
      finally { submitting.current = false; setBusy(false); }
    }}>
      <h2>Вход в демонстрацию</h2>
      <p>Номер и код уже заполнены. SMS не отправляется.</p>
      <label className="field"><span>Номер телефона</span>
        <input type="tel" inputMode="tel" autoComplete="tel" required pattern="[0-9]{11}" value={phone} onChange={event => setPhone(event.target.value)} />
      </label>
      <label className="field"><span>Код подтверждения</span>
        <input inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{4}" maxLength={4} value={code} onChange={event => setCode(event.target.value)} />
      </label>
      <Button type="submit" disabled={busy}>{busy ? "Входим…" : "Войти"}</Button>
      {error && <p role="alert">{error}</p>}
      <p className="privacy">Это тестовый вход без проверки номера. Документы доступны в этом браузере; фотографии сохраняются в отдельной закрытой папке сервера для этого браузера.</p>
    </form>}
  </main>;
}
