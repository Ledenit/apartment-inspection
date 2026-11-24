import {
  useEffect,
  useRef,
  useState,
  useId,
  ReactNode,
  ButtonHTMLAttributes,
} from "react";
import { Photo } from "./model";
const dialogOpeners = new WeakMap<HTMLDialogElement, HTMLElement[]>();

function captureFocusReturnTargets() {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return [];
  const parent = active.closest("dialog");
  return [active, ...(parent ? (dialogOpeners.get(parent) ?? []) : [])];
}
export function Icon({
  name,
}: {
  name:
    | "back"
    | "plus"
    | "arrow"
    | "chevron"
    | "warning"
    | "clipboard"
    | "calendar"
    | "camera"
    | "info"
    | "pencil"
    | "trash"
    | "copy";
}) {
  const paths = {
    back: "M19 12H5m7-7-7 7 7 7",
    plus: "M12 5v14M5 12h14",
    arrow: "M5 12h14m-7-7 7 7-7 7",
    chevron: "m9 5 7 7-7 7",
    warning: "M12 3 2 21h20L12 3Zm0 6v5m0 3v1",
    clipboard: "M9 4H5v18h14V4h-4M9 2h6v4H9V2Z",
    calendar: "M4 5h16v16H4V5Zm3-3v6m10-6v6M4 10h16",
    camera: "M3 7h4l2-3h6l2 3h4v14H3V7Zm13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
    info: "M12 10v7m0-10v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
    pencil: "m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z",
    trash: "M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7",
    copy: "M9 8h12v13H9V8ZM15 8V3H3v13h6",
  };
  return (
    <svg
      aria-hidden="true"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function Button({
  children,
  kind = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: "primary" | "outline" | "plain";
}) {
  return (
    <button className={`button ${kind} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function Header({
  title,
  back,
  onBack,
  onMenu,
  editableTitle = false,
  children,
}: {
  title: ReactNode;
  editableTitle?: boolean;
  back?: string;
  onBack?: () => void;
  onMenu?: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="screen-header">
      {back && (
        <button className="back" onClick={onBack}>
          <Icon name="back" />
          {back}
        </button>
      )}
      <div className="title-row">
        <h1 tabIndex={-1} className={editableTitle ? "editable-title" : undefined}>{title}</h1>
        {onMenu && (
          <button
            className="icon-button more-button"
            aria-label="Действия"
            onClick={onMenu}
          >
            <img
              alt=""
              src="/assets/dc4b13f1-830b-45fb-b259-4f098ba73322.svg"
            />
          </button>
        )}
      </div>
      {children}
    </header>
  );
}
export function SectionHeading({
  title,
  count,
  add,
  warning = false,
}: {
  title: string;
  count?: number;
  add?: () => void;
  warning?: boolean;
}) {
  return (
    <div
      className={`section-heading ${!add && count === undefined ? "plain-heading" : ""}`}
    >
      <h2>
        {warning && <Icon name="warning" />}
        {title}
        {count !== undefined && <span className="badge">{count}</span>}
      </h2>
      {add && (
        <Button onClick={add}>
          <Icon name="plus" />
          Добавить
        </Button>
      )}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  compact = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  compact?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [returnTargets] = useState(captureFocusReturnTargets);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    const position = () => {
      if (!compact || !dialog) return;
      const anchor = returnTargets[0]?.getBoundingClientRect();
      const width = dialog.getBoundingClientRect().width;
      dialog.style.left = `${Math.max(12, Math.min((anchor?.right ?? innerWidth - 18) - width, innerWidth - width - 12))}px`;
      dialog.style.top = `${Math.max(12, Math.min((anchor?.bottom ?? 100) + 8, innerHeight - dialog.getBoundingClientRect().height - 12))}px`;
    };
    if (dialog) dialogOpeners.set(dialog, returnTargets);
    dialog?.showModal();
    position();
    if (compact) window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("resize", position);
      dialog?.close();
      if (dialog) dialogOpeners.delete(dialog);
      queueMicrotask(() => {
        const top = Array.from(document.querySelectorAll("dialog[open]")).at(
          -1,
        );
        const target = returnTargets.find(
          (element) =>
            element.isConnected &&
            !element.matches(":disabled, [inert]") &&
            (!top || top.contains(element)),
        );
        target?.focus();
      });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      className={compact ? "action-menu-dialog" : wide ? "wide-dialog" : ""}
      aria-labelledby={id}
      onClick={(event) => {
        if (!compact || event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const dialog = event.currentTarget;
        // Native inertness alone can send the final Tab to browser chrome.
        const controls = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            "button, a[href], input, textarea, select, [tabindex]",
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(":disabled, [hidden], [inert]") &&
            element.getClientRects().length > 0,
        );
        const first = controls[0],
          last = controls.at(-1);
        if (!first) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const active = document.activeElement;
        if (
          event.shiftKey &&
          (active === first || active === dialog || !dialog.contains(active))
        ) {
          event.preventDefault();
          last!.focus();
        } else if (
          !event.shiftKey &&
          (active === last || active === dialog || !dialog.contains(active))
        ) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className={compact ? "sr-only" : "dialog-title"}>
        <h2 id={id}>{title}</h2>
        {!compact && <button className="icon-button" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>}
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  value,
  onChange,
  multiline = false,
  type = "text",
  required = false,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  multiline?: boolean;
  type?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  const errorId = useId();
  const invalid = required && !value.trim();
  return (
    <label className="field">
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={5}
          autoFocus={autoFocus}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          autoFocus={autoFocus}
        />
      )}
      {invalid && (
        <span className="field-hint" id={errorId}>
          Заполните поле «{label}»
        </span>
      )}
    </label>
  );
}
export function Description({
  value,
  edit,
}: {
  value: string;
  edit: () => void;
}) {
  return (
    <section className="description">
      <div className="description-heading">
        <strong>Описание</strong>
        <button
          className="icon-button"
          aria-label="Изменить описание"
          onClick={edit}
        >
          <img src="/assets/79e7916b-f642-44fd-b959-c194d583b3d1.svg" alt="" />
        </button>
      </div>
      <p className={value ? undefined : "muted"}>{value || "Введите ваше описание"}</p>
    </section>
  );
}
export function PhotoImage({
  photo,
  alt = "",
  className = "",
}: {
  photo: Photo;
  alt?: string;
  className?: string;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = URL.createObjectURL(photo.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [photo.blob]);
  return <img className={className} src={url || undefined} alt={alt} />;
}
export function Row({
  title,
  subtitle,
  photo,
  onClick,
  children,
}: {
  title: string;
  subtitle?: string;
  photo?: Photo;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button className="list-row" onClick={onClick}>
      {photo && <PhotoImage photo={photo} className="thumbnail" />}
      <span className="row-copy">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
        {children}
      </span>
      <Icon name="chevron" />
    </button>
  );
}
