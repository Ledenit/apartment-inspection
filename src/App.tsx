import { useEffect, useRef, useState } from "react";
import {
  Inspection,
  Room,
  RoomType,
  Defect,
  Photo,
  roomTypes,
  newRoom,
  uniqueRoomName,
  localDate,
  displayDate,
  roomCount,
  defectCount,
  totalDefects,
  getChecklist,
  config,
  StorageError,
  validateDocument,
} from "./model";
import { repository, storageError } from "./repository";
import { DraftSession } from "./session";
import { preparePhoto } from "./photos";
import { addPhotoBatch } from "./photo-batch";
import { record } from "./analytics";
import { canSharePdf, sharePdf } from "./pdf-share";
import { PdfStatus } from "./pdf-status";
import type { PdfStage } from "./pdf";
import { Checklist } from "./checklist";
import { synchronizePhotos, type PhotoSyncStatus } from "./photo-sync";
import { loadPublicSiteUrl } from "./site-config";
import {
  Button,
  Header,
  SectionHeading,
  Modal,
  Field,
  Description,
  PhotoImage,
  Row,
  Icon,
} from "./ui";
type Route =
  "library" | "new" | "document" | "room" | "defect" | "help" | "preview";
type Dialog = {
  title: string;
  body?: string;
  confirm?: () => void | Promise<void>;
  danger?: boolean;
} | null;
const privacy =
  "Документы хранятся в этом браузере, фото также загружаются на сервер. Очистка данных браузера удалит локальные осмотры.";
const errorText = (e: StorageError) =>
  ({
    conflict:
      "Документ изменён в другой вкладке. Ваш ввод сохранён на этом экране. Перечитайте документ, чтобы продолжить.",
    quota:
      "Недостаточно места в браузере. Ввод остаётся на экране. Освободите место и повторите сохранение.",
    unavailable:
      "Не получилось сохранить данные в браузере. Ввод остаётся на экране. Проверьте доступ к хранилищу и повторите.",
    invalid: "Проверьте обязательные поля: адрес, дату и название дефекта.",
    "not-found":
      "Документ удалён в другой вкладке. Ваш ввод остаётся на экране.",
  })[e.code];
export default function App() {
  const [photoSync, setPhotoSync] = useState<PhotoSyncStatus>("syncing");
  const photoSyncWorker = useRef<ReturnType<typeof synchronizePhotos> | null>(null);
  useEffect(() => {
    const worker = synchronizePhotos(repository, setPhotoSync);
    photoSyncWorker.current = worker;
    return () => { worker.stop(); };
  }, []);
  const [route, setRoute] = useState<Route>("library"),
    [docs, setDocs] = useState<Inspection[]>([]),
    [loading, setLoading] = useState(true),
    [globalError, setGlobalError] = useState("");
  const [, redraw] = useState(0);
  const session = useRef<DraftSession | null>(null);
  const s = session.current,
    d = s?.draft;
  const [defectNew, setDefectNew] = useState(false);
  const [roomId, setRoomId] = useState(""),
    [defect, setDefect] = useState<Defect | null>(null);
  const defectRef = useRef<Defect | null>(null);
  const r = d?.rooms.find((v) => v.id === roomId);
  const [newDoc, setNewDoc] = useState({
    title: "",
    address: "",
    inspectionDate: localDate(),
    description: "",
  });
  const newDocRef = useRef(newDoc);
  const creating = useRef<Promise<DraftSession> | null>(null);
  const photoOperation = useRef<object | null>(null);
  const [busy, setBusy] = useState(false),
    [photoBusy, setPhotoBusy] = useState(false),
    [photoError, setPhotoError] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null),
    [dateEditing, setDateEditing] = useState(false),
    [menu, setMenu] = useState(false),
    [editor, setEditor] = useState<"description" | "details" | "room" | null>(
      null,
    ),
    [addRoom, setAddRoom] = useState(false),
    [customRoom, setCustomRoom] = useState("");
  const [helpParent, setHelpParent] = useState<"document" | "room">("document");
  const [helpType, setHelpType] = useState<RoomType>("Комната"),
    [helpItem, setHelpItem] = useState("");
  const [photoTarget, setPhotoTarget] = useState<"room" | "defect" | null>(
      null,
    ),
    [viewPhoto, setViewPhoto] = useState<{
      target: "room" | "defect";
      id: string;
    } | null>(null);
  const [pdf, setPdf] = useState<{ url: string; name: string; file: File } | null>(null),
    [pdfError, setPdfError] = useState("");
  const [sharing, setSharing] = useState(false),
    [shareError, setShareError] = useState("");
  const [pdfStage, setPdfStage] = useState<PdfStage>(0);
  const documentOperation = useRef(false);
  const shareOperation = useRef(false);
  const pdfUrl = useRef("");
  const galleryInput = useRef<HTMLInputElement>(null),
    cameraInput = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    setLoading(true);
    try {
      setDocs(await repository.listDocuments());
      setGlobalError("");
    } catch (e) {
      setGlobalError(errorText(storageError(e)));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    return () => {
      if (pdfUrl.current) URL.revokeObjectURL(pdfUrl.current);
    };
  }, []);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (
        session.current?.dirty ||
        session.current?.saving ||
        photoBusy ||
        (route === "new" &&
          !session.current &&
          !!(
            newDocRef.current.title ||
            newDocRef.current.address ||
            newDocRef.current.description
          )) ||
        (route === "defect" && !defectRef.current?.title.trim())
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [photoBusy, route]);
  useEffect(() => {
    window.scrollTo(0, 0);
    document.querySelector<HTMLElement>(route === "defect" && defectNew ? ".editable-title input" : "h1")?.focus({ preventScroll: true });
  }, [route, roomId]);
  const edit = (mutate: (v: Inspection) => void) => s?.edit(mutate);
  const editRoom = (mutate: (v: Room) => void) =>
    edit((v) => {
      const room = v.rooms.find((x) => x.id === roomId);
      if (room) mutate(room);
    });
  const editDefect = (mutation: (v: Defect) => void) => {
    const next = structuredClone(defectRef.current!);
    mutation(next);
    defectRef.current = next;
    setDefect(next);
    if (next.title.trim())
      editRoom((room) => {
        const index = room.defects.findIndex((f) => f.id === next.id);
        if (index < 0) room.defects.push(next);
        else room.defects[index] = next;
      });
  };
  const go = async (next: Route) => {
    if (photoOperation.current || documentOperation.current || shareOperation.current || busy) return;
    if (route === "new") {
      if (!validNewDocument()) {
        setDialog({
          title: "Отбросить незавершённый ввод?",
          body: "Адрес и дата обязательны. Несохранённые реквизиты и описание будут потеряны.",
          danger: true,
          confirm: async () => {
            try {
              if (session.current) await session.current.reload();
              setRoute(next);
              if (next === "library") await refresh();
            } catch (e) {
              setGlobalError(errorText(storageError(e)));
            }
          },
        });
        return;
      }
      try {
        const current = await create();
        await current.flush();
        setRoute(next);
        if (next === "library") await refresh();
      } catch {
        /* Creation and storage errors keep the inline draft visible. */
      }
      return;
    }
    if (route === "defect" && !defectRef.current?.title.trim()) {
      setDialog({
        title: "Название дефекта обязательно",
        body: "Продолжите редактирование или отбросьте несохранённый ввод.",
        confirm: async () => {
          setBusy(true);
          try {
            await s!.discardDefect(roomId, defectRef.current!.id, defectNew);
            setDefect(null);
            defectRef.current = null;
            setRoute(next);
          } catch (e) {
            setGlobalError(errorText(storageError(e)));
          } finally {
            setBusy(false);
          }
        },
        danger: true,
      });
      return;
    }
    try {
      await s?.flush();
      setRoute(next);
      if (next === "library") await refresh();
    } catch {
      /* inline storage status preserves draft */
    }
  };
  const openDocument = async (id: string) => {
    setLoading(true);
    try {
      const doc = await repository.getDocument(id);
      session.current = new DraftSession(repository, doc, () =>
        redraw((n) => n + 1),
      );
      setRoute("document");
      setGlobalError("");
    } catch (e) {
      setGlobalError(errorText(storageError(e)));
    } finally {
      setLoading(false);
    }
  };
  const validNewDocument = () => {
    try {
      validateDocument({
        ...newDocRef.current,
        id: "draft",
        rooms: [],
        createdAt: 0,
        updatedAt: 0,
        revision: 1,
      });
      return true;
    } catch {
      return false;
    }
  };
  const beginDocument = () => {
    session.current = null;
    const draft = {
      title: "",
      address: "",
      inspectionDate: localDate(),
      description: "",
    };
    newDocRef.current = draft;
    setNewDoc(draft);
    setGlobalError("");
    setRoute("new");
  };
  const editNewDocument = (patch: Partial<typeof newDoc>) => {
    const draft = { ...newDocRef.current, ...patch };
    newDocRef.current = draft;
    setNewDoc(draft);
    if (session.current) session.current.edit((v) => Object.assign(v, draft));
  };
  const create = (): Promise<DraftSession> => {
    if (creating.current) return creating.current;
    if (session.current) return Promise.resolve(session.current);
    if (!validNewDocument()) {
      setGlobalError("Введите адрес и корректную дату осмотра.");
      return Promise.reject(new StorageError("invalid"));
    }
    setBusy(true);
    creating.current = (async () => {
      try {
        const doc = await repository.createDocument(newDocRef.current);
        record("document_created");
        session.current = new DraftSession(repository, doc, () =>
          redraw((n) => n + 1),
        );
        session.current.edit((v) => Object.assign(v, newDocRef.current));
        await session.current.flush();
        setGlobalError("");
        return session.current;
      } catch (e) {
        setGlobalError(errorText(storageError(e)));
        throw e;
      } finally {
        setBusy(false);
        creating.current = null;
      }
    })();
    return creating.current;
  };
  useEffect(() => {
    if (route !== "new" || session.current || !validNewDocument()) return;
    const timer = window.setTimeout(() => {
      void create().catch(() => {});
    }, 350);
    return () => window.clearTimeout(timer);
  }, [route, newDoc]);
  const requestRoom = async () => {
    if (photoOperation.current) return;
    try {
      const current = route === "new" ? await create() : session.current!;
      await current.flush();
      setAddRoom(true);
    } catch {
      /* Keep draft and visible storage errors. */
    }
  };
  const openRoom = async (room: Room) => {
    if (photoOperation.current) return;
    try {
      await s?.flush();
      setRoomId(room.id);
      setRoute("room");
    } catch {}
  };
  const startDefect = (value?: Defect) => {
    if (photoOperation.current || busy) return;
    setDefectNew(!value);
    const f = value
      ? structuredClone(value)
      : { id: crypto.randomUUID(), title: "", description: "", photos: [] };
    defectRef.current = f;
    setDefect(f);
    setRoute("defect");
  };
  const insertRoom = async (type: RoomType, name = type as string) => {
    if (photoOperation.current || busy) return;
    const room = newRoom(type, name, s!.draft.rooms);
    edit((v) => v.rooms.push(room));
    setAddRoom(false);
    setCustomRoom("");
    await openRoom(room);
  };
  const confirmDelete = () => {
    if (photoOperation.current || busy) return;
    setMenu(false);
    const name =
      route === "document"
        ? d!.title || d!.address
        : route === "room"
          ? r!.name
          : defect!.title;
    setDialog({
      title: `Удалить «${name}»?`,
      body: "Это действие нельзя отменить. Фотографии тоже будут удалены.",
      danger: true,
      confirm: async () => {
        if (photoOperation.current) return;
        try {
          await s!.flush();
          if (route === "document") {
            await repository.deleteDocument(d!.id, s!.draft.revision);
            session.current = null;
            setRoute("library");
            await refresh();
          } else if (route === "room") {
            edit((v) => {
              v.rooms = v.rooms.filter((x) => x.id !== roomId);
            });
            await s!.flush();
            setRoute("document");
          } else {
            editRoom((v) => {
              v.defects = v.defects.filter((x) => x.id !== defect!.id);
            });
            await s!.flush();
            setRoute("room");
          }
        } catch (e) {
          setGlobalError(errorText(storageError(e)));
        }
      },
    });
  };
  const generate = async () => {
    if (documentOperation.current || photoOperation.current || shareOperation.current) return;
    documentOperation.current = true;
    setBusy(true);
    setPdfError("");
    setShareError("");
    setPdf(null);
    setPdfStage(0);
    if (pdfUrl.current) URL.revokeObjectURL(pdfUrl.current);
    pdfUrl.current = "";
    try {
      await s!.flush();
      setRoute("preview");
      const snapshot = structuredClone(s!.draft);
      const { buildPdf, pdfFilename } = await import("./pdf");
      const siteUrl = await loadPublicSiteUrl();
      const blob = await buildPdf(snapshot, undefined, siteUrl, setPdfStage);
      pdfUrl.current = URL.createObjectURL(blob);
      const name = pdfFilename(snapshot);
      setPdf({ url: pdfUrl.current, name, file: new File([blob], name, { type: "application/pdf" }) });
      record("preview_opened");
    } catch (e) {
      if (!s?.error) {
        setRoute("preview");
        setPdfError("Не получилось создать PDF, попробуйте ещё раз.");
      }
    } finally {
      documentOperation.current = false;
      setBusy(false);
    }
  };
  const duplicate = async () => {
    if (documentOperation.current || photoOperation.current || busy) return;
    documentOperation.current = true;
    setBusy(true);
    const owner = session.current!;
    try {
      await owner.flush();
      const copy = await repository.duplicateDocument(owner.draft.id, owner.draft.revision);
      session.current = new DraftSession(repository, copy, () => redraw((n) => n + 1));
      setMenu(false);
      setGlobalError("");
      setPdf(null);
      if (pdfUrl.current) URL.revokeObjectURL(pdfUrl.current);
      pdfUrl.current = "";
      setRoute("document");
    } catch (e) {
      setMenu(false);
      setGlobalError(errorText(storageError(e)));
    } finally {
      documentOperation.current = false;
      setBusy(false);
    }
  };
  const share = async () => {
    if (!pdf || shareOperation.current) return;
    shareOperation.current = true;
    setSharing(true);
    setShareError("");
    try {
      await sharePdf(pdf.file);
    } catch {
      setShareError("Не получилось поделиться PDF. Повторите или скачайте файл.");
    } finally {
      shareOperation.current = false;
      setSharing(false);
    }
  };
  const addFiles = async (files: FileList | null) => {
    if (!files?.length || !photoTarget || photoOperation.current) return;
    const target = photoTarget;
    const owner = session.current;
    const ownerRoom = roomId;
    const ownerDefect = defectRef.current?.id;
    const token = {};
    photoOperation.current = token;
    const current = () => {
      if (photoOperation.current !== token || session.current !== owner)
        return undefined;
      const room = owner?.draft.rooms.find((v) => v.id === ownerRoom);
      if (!room) return undefined;
      if (target === "room") return room.photos;
      const activeDefect = defectRef.current;
      return activeDefect && activeDefect.id === ownerDefect
        ? activeDefect.photos
        : undefined;
    };
    setPhotoTarget(null);
    setPhotoError("");
    setPhotoBusy(true);
    try {
      const result = await addPhotoBatch(
        Array.from(files),
        target === "room" ? config.roomPhotos : config.defectPhotos,
        current,
        preparePhoto,
        (photo) => {
          if (!current()) return;
          if (target === "room")
            owner!.edit((v) => {
              v.rooms.find((room) => room.id === ownerRoom)!.photos.push(photo);
            });
          else
            editDefect((v) => {
              v.photos.push(photo);
            });
        },
      );
      if (result.overflow)
        setPhotoError(
          "Весь выбранный набор превышает лимит фотографий. Выберите меньше файлов; набор не добавлен.",
        );
      else if (result.errors)
        setPhotoError(
          `Не удалось прочитать файлов: ${result.errors}. Остальные фото добавлены. Выберите JPEG или PNG и повторите.`,
        );
    } catch {
      setPhotoError("Не получилось добавить фото. Выберите файлы и повторите.");
    } finally {
      if (photoOperation.current === token) photoOperation.current = null;
      setPhotoBusy(false);
      if (galleryInput.current) galleryInput.current.value = "";
      if (cameraInput.current) cameraInput.current.value = "";
    }
  };
  const photosOf = (target: "room" | "defect") =>
    target === "room" ? (r?.photos ?? []) : (defect?.photos ?? []);
  const updatePhoto = (
    target: "room" | "defect",
    id: string,
    mutation: (p: Photo) => void,
  ) => {
    if (target === "room")
      editRoom((v) => {
        const p = v.photos.find((x) => x.id === id);
        if (p) mutation(p);
      });
    else
      editDefect((v) => {
        const p = v.photos.find((x) => x.id === id);
        if (p) mutation(p);
      });
  };
  const photoGrid = (target: "room" | "defect") => (
    <div className="photo-grid">
      {photosOf(target).map((p) => (
        <figure key={p.id}>
          <button
            className="photo-open"
            aria-label={`Открыть фото ${p.caption || photosOf(target).indexOf(p) + 1}`}
            onClick={() => setViewPhoto({ target, id: p.id })}
          >
            <PhotoImage photo={p} />
          </button>
          {p.caption && <figcaption>{p.caption}</figcaption>}
        </figure>
      ))}
      {Array.from({length: target === "defect" && photosOf(target).length === 0 ? 3 : 1}, (_, index) => <button
        key={`add-${index}`}
        aria-label={index ? `Добавить фото, ячейка ${index + 1}` : undefined}
        disabled={
          photoBusy ||
          photosOf(target).length >=
            (target === "room" ? config.roomPhotos : config.defectPhotos)
        }
        className="photo-add"
        onClick={() => {
          setPhotoTarget(target);
          setPhotoError("");
        }}
      >
        <Icon name="plus" />
        Фото
      </button>)}
    </div>
  );
  const viewed = viewPhoto
    ? photosOf(viewPhoto.target).find((p) => p.id === viewPhoto.id)
    : undefined;
  const storageStatus =
    s &&
    (s.error ? (
      <div role="alert" className="status error">
        <p>{errorText(s.error)}</p>
        {s.error.code === "conflict" ? (
          <Button
            kind="outline"
            onClick={() =>
              setDialog({
                title: "Перечитать документ?",
                body: "Несохранённые изменения на этом экране будут отброшены. Загрузится последняя сохранённая версия.",
                danger: true,
                confirm: async () => {
                  try {
                    await s.reload();
                    setRoute("document");
                    setDefect(null);
                  } catch (e) {
                    setGlobalError(errorText(storageError(e)));
                  }
                },
              })
            }
          >
            Перечитать документ
          </Button>
        ) : (
          <Button
            kind="outline"
            onClick={() =>
              void s
                .retry()
                .then(() => setGlobalError(""))
                .catch(() => {})
            }
          >
            Повторить сохранение
          </Button>
        )}
      </div>
    ) : s.saving ? (
      <div className="status" role="status">
        Сохраняем…
      </div>
    ) : null);
  return (
    <main
      className={`app route-${route} ${route === "library" || route === "new" || route === "help" ? "narrow" : ""}`}
    >
      {photoSync === "syncing" && <p className="status" role="status">Синхронизируем фото с сервером…</p>}
      {photoSync === "error" && !globalError && !s?.error && <div className="error" role="alert">
        <p>Не получилось синхронизировать фото с сервером. Локально сохранённые изменения остаются в браузере.</p>
        <Button kind="outline" onClick={() => photoSyncWorker.current?.retry()}>Повторить загрузку фото</Button>
      </div>}
      {route === "library" && (
        <>
          <Header title="Библиотека" />
          {loading ? (
            <p role="status">Загружаем документы…</p>
          ) : docs.length ? (
            <section className="stack library">
              <SectionHeading title="Документы" count={docs.length} />
              <p className="privacy">{privacy}</p>
              <div className="inset-list">
                {docs.map((doc) => (
                  <Row
                    key={doc.id}
                    title={doc.title || doc.address}
                    onClick={() => void openDocument(doc.id)}
                    subtitle={`${doc.address} · ${displayDate(doc.inspectionDate)}`}
                  >
                    <span>
                      {roomCount(doc.rooms.length)} ·{" "}
                      {defectCount(totalDefects(doc))}
                    </span>
                  </Row>
                ))}
              </div>
              <Button onClick={beginDocument}>
                <Icon name="plus" />
                Новый документ
              </Button>
            </section>
          ) : (
            <section className="empty-library">
              <SectionHeading title="Пока нет документов" />
              <div className="empty-art">
                <img
                  src="/assets/822e16ff-44b9-463a-8f2f-cf3779351d16.png"
                  alt=""
                />
                <p>
                  Создайте документ осмотра: добавьте комнаты, фотографии и
                  найденные дефекты.
                </p>
              </div>
              <Button onClick={beginDocument}>
                <Icon name="plus" />
                Новый документ
              </Button>
              <p className="privacy">{privacy}</p>
            </section>
          )}
        </>
      )}
      {route === "new" && (
        <>
          <header className="screen-header new-header">
            <button className="back" onClick={() => void go("library")}>
              <Icon name="back" />В библиотеку
            </button>
            <div className="title-row">
              <h1 className="editable-title">
                <label>
                  <span className="sr-only">Название документа</span>
                  <input
                    aria-label="Название документа"
                    placeholder="Название квартиры"
                    value={newDoc.title}
                    onChange={(e) => editNewDocument({ title: e.target.value })}
                  />
                </label>
              </h1>
            </div>
            <label className="inline-address">
              <span className="sr-only">Адрес *</span>
              <input
                required
                placeholder="Адрес квартиры"
                value={newDoc.address}
                onChange={(e) => editNewDocument({ address: e.target.value })}
                aria-describedby={
                  !newDoc.address.trim() ? "new-address-error" : undefined
                }
                aria-invalid={!newDoc.address.trim()}
              />
            </label>
            {!newDoc.address.trim() && (
              <span id="new-address-error" className="field-hint">
                Укажите адрес, чтобы сохранить документ
              </span>
            )}
            <button
              className="date-button"
              aria-haspopup="dialog"
              onClick={() => setDateEditing(true)}
            >
              Дата осмотра:{" "}
              {newDoc.inspectionDate
                ? displayDate(newDoc.inspectionDate)
                : "укажите дату"}
              <span className="calendar-target">
                <Icon name="calendar" />
              </span>
            </button>
            {!newDoc.inspectionDate && (
              <span id="new-date-error" className="field-hint">
                Укажите дату осмотра
              </span>
            )}
            <Description
              value={newDoc.description}
              edit={() => setEditor("description")}
            />
          </header>
          <section className="empty-rooms">
            <h2>Нет добавленных комнат</h2>
            <p>Добавьте запись о комнате по кнопке снизу</p>
            <Button disabled={busy} onClick={() => void requestRoom()}>
              <Icon name="plus" />
              Добавить комнату
            </Button>
          </section>
          {!s && (
            <p className="privacy">
              Черновик пока только на экране. Заполните адрес и дату — документ
              сохранится автоматически.
            </p>
          )}
          {busy && <p role="status">Создаём документ…</p>}
          {globalError && !s && (
            <Button
              kind="outline"
              disabled={busy}
              onClick={() => void create().catch(() => {})}
            >
              Повторить сохранение
            </Button>
          )}
        </>
      )}
      {route === "document" && d && (
        <>
          <Header
            title={d.title || d.address}
            back="В библиотеку"
            onBack={() => void go("library")}
            onMenu={() => {
              if (!photoOperation.current && !busy) setMenu(true);
            }}
          >
            <div className="document-meta">
              <strong>{d.address}</strong>
              <button
                className="date-button"
                onClick={() => setEditor("details")}
              >
                Дата осмотра: {displayDate(d.inspectionDate)}
                <span className="calendar-target">
                  <Icon name="calendar" />
                </span>
              </button>
            </div>
          </Header>
          <div className="content-columns">
            <div className="stack">
              <Description
                value={d.description}
                edit={() => setEditor("description")}
              />
              <section className="stack general-checklist">
                <SectionHeading title="Общее по квартире" />
                <Button kind="outline" className="general-help" onClick={() => {
                  setHelpParent("document");
                  setHelpType("Общее");
                  setHelpItem(getChecklist("Общее")[0].id);
                  void go("help");
                }}><Icon name="info" />Не знаете, что фиксировать?<Icon name="arrow" /></Button>
                <Checklist type="Общее" checked={d.generalCheckedItemIds ?? []}
                  onChange={items => edit(v => {v.generalCheckedItemIds = items;})}
                  onHelp={() => {
                    setHelpParent("document"); setHelpType("Общее");
                    setHelpItem(getChecklist("Общее")[0].id); void go("help");
                  }} />
              </section>
            </div>
            <div className="stack compact">
              {d.rooms.length ? (
                <>
                  <SectionHeading
                    title="Комнаты"
                    count={d.rooms.length}
                    add={() => void requestRoom()}
                  />
                  <div className="inset-list">
                    {d.rooms.map((room) => (
                      <Row
                        key={room.id}
                        title={room.name}
                        subtitle={`${room.photos.length} фото · ${defectCount(room.defects.length)}`}
                        photo={room.photos[0]}
                        onClick={() => void openRoom(room)}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <section className="empty-rooms">
                  <h2>Нет добавленных комнат</h2>
                  <p>Добавьте запись о комнате по кнопке снизу</p>
                  <Button onClick={() => void requestRoom()}>
                    <Icon name="plus" />
                    Добавить комнату
                  </Button>
                </section>
              )}
            </div>
          </div>
          <div className="action-bar">
            <Button
              kind="outline"
              disabled={busy || photoBusy}
              onClick={() => void generate()}
            >
              Сформировать PDF
              <Icon name="arrow" />
            </Button>
          </div>
        </>
      )}
      {route === "room" && r && (
        <>
          <Header
            title={r.name}
            back="К документу"
            onBack={() => void go("document")}
            onMenu={() => {
              if (!photoOperation.current && !busy) setMenu(true);
            }}
          >
            <strong className="summary">
              {r.photos.length} фото · {defectCount(r.defects.length)}
            </strong>
          </Header>
          <div className="content-columns">
            <div className="stack">
              <Description
                value={r.description}
                edit={() => setEditor("description")}
              />
              <Checklist key={r.id} type={r.type} checked={r.checkedItemIds}
                onChange={items => editRoom(v => {v.checkedItemIds = items;})}
                onHelp={() => {
                  setHelpParent("room"); setHelpType(r.type);
                  setHelpItem(getChecklist(r.type)[0].id); void go("help");
                }} />
            </div>
            <div className="stack">
              <section className="stack compact">
                {r.defects.length > 0 && <SectionHeading title="Дефекты" warning count={r.defects.length} add={() => startDefect()} />}
                {r.defects.length ? (
                  <div className="inset-list">
                    {r.defects.map((f) => (
                      <Row
                        key={f.id}
                        title={f.title}
                        subtitle={f.description}
                        photo={f.photos[0]}
                        onClick={() => startDefect(f)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="empty-defects">
                    <h2>Дефекты пока не отмечены</h2>
                    <p>Если заметите повреждение, добавьте его</p>
                    <Button onClick={() => startDefect()}><Icon name="plus" />Добавить дефект</Button>
                  </div>
                )}
              </section>
              <section className="stack compact">
                <SectionHeading title="Фото комнаты" />
                {photoGrid("room")}
                <p className="photo-limit">
                  {r.photos.length} из {config.roomPhotos} фото
                </p>
              </section>
            </div>
          </div>
          <div className="action-bar">
            <Button
              kind="outline"
              disabled={photoBusy}
              onClick={() => void go("document")}
            >
              Готово, к документу
              <Icon name="arrow" />
            </Button>
          </div>
        </>
      )}
      {route === "defect" && defect && r && (
        <>
          <Header
            editableTitle={defectNew}
            title={defectNew ? (
              <label>
                <span className="sr-only">Название дефекта</span>
                <input aria-label="Название дефекта" placeholder="Название дефекта" required value={defect.title}
                  onChange={e => editDefect(v => {v.title = e.target.value;})} />
              </label>
            ) : defect.title}
            back="К комнате"
            onBack={() => void go("room")}
            onMenu={() => {
              if (!photoOperation.current && !busy) setMenu(true);
            }}
          >
            <strong className="summary">Где находится: {r.name}</strong>
          </Header>
          <div className="content-columns">
            <Description
              value={defect.description}
              edit={() => setEditor("description")}
            />
            <section className="stack compact">
              <SectionHeading title="Фото дефекта" />
              {photoGrid("defect")}
              <p className="photo-limit">
                {defect.photos.length} из {config.defectPhotos} фото
              </p>
            </section>
          </div>
          <div className="action-bar">
            <Button disabled={photoBusy} onClick={() => void go("room")}>
              Сохранить
            </Button>
          </div>
        </>
      )}
      {route === "help" && d && (
        <>
          <Header
            title={"Что проверить\nи как снять"}
            back={helpParent === "room" && r ? `К осмотру ${r.name}` : "К документу"}
            onBack={() => void go(helpParent === "room" && r ? "room" : "document")}
          />
          <label className="field help-select">
            <span>Раздел справки</span>
            <span className="select-control">
              <select
                value={helpType}
                onChange={(e) => {
                  const type = e.target.value as RoomType;
                  setHelpType(type);
                  setHelpItem(getChecklist(type)[0].id);
                }}
              >
                {roomTypes.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <span className="select-chevron">
                <Icon name="chevron" />
              </span>
            </span>
          </label>
          <div className="help-list">
            {getChecklist(helpType).map((item, index) => (
              <section key={item.id}>
                <button
                  className="help-toggle"
                  aria-expanded={helpItem === item.id}
                  aria-controls={`help-${item.id}`}
                  onClick={() =>
                    setHelpItem(helpItem === item.id ? "" : item.id)
                  }
                >
                  <span className={helpItem === item.id ? "rotate-down" : ""}>
                    <Icon name="chevron" />
                  </span>
                  {item.title}
                </button>
                {helpItem === item.id && (
                  <div id={`help-${item.id}`}>
                    <p>{item.hint}</p>
                    {index === 0 && (
                      <div className="example">
                        <span>Место для примера кадра</span>
                        <strong>
                          {helpType === "Комната"
                            ? "Стена с трещиной"
                            : item.title}
                        </strong>
                      </div>
                    )}
                  </div>
                )}
              </section>
            ))}
          </div>
        </>
      )}
      {route === "preview" && (
        <>
          <Header
            title="Предпросмотр PDF"
            back="К документу"
            onBack={() => void go("document")}
          />
          {busy ? (
            <PdfStatus ready={false} stage={pdfStage} />
          ) : pdfError ? (
            <div role="alert">
              <p>{pdfError}</p>
              <Button onClick={() => void generate()}>Повторить</Button>
            </div>
          ) : (
            pdf && (
              <>
                <PdfStatus ready />
                <a
                  className="button primary"
                  href={pdf.url}
                  download={pdf.name}
                  onClick={() => record("pdf_downloaded")}
                >
                  Скачать PDF
                </a>
                {canSharePdf(pdf.file) ? (
                  <Button kind="outline" disabled={sharing} onClick={() => void share()}>
                    {sharing ? "Открываем системное меню…" : "Поделиться PDF"}
                  </Button>
                ) : (
                  <p className="muted">В этом браузере отправка PDF через системное меню недоступна. Скачайте файл, чтобы передать его.</p>
                )}
                {shareError && <p role="alert">{shareError}</p>}
                <a
                  className="preview-link"
                  href={pdf.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Открыть PDF в отдельной вкладке
                </a>
                <iframe
                  className="pdf-preview"
                  title="Документ осмотра PDF"
                  tabIndex={0}
                  src={pdf.url}
                />
              </>
            )
          )}
        </>
      )}
      {globalError && (
        <div className="status error" role="alert">
          <p>{globalError}</p>
          {route === "library" && (
            <Button kind="outline" onClick={() => void refresh()}>
              Повторить
            </Button>
          )}
          <button className="text-button" onClick={() => setGlobalError("")}>
            Закрыть сообщение
          </button>
        </div>
      )}
      {route !== "library" && storageStatus}
      {photoBusy && (
        <p role="status" className="status">
          Обрабатываем фото…
        </p>
      )}
      {photoError && (
        <p role="alert" className="status error">
          {photoError}
        </p>
      )}
      {menu && (
        <Modal title="Действия" compact onClose={() => { if (!documentOperation.current) setMenu(false); }}>
          <div className="stack">
            <Button
              kind="outline"
              disabled={busy}
              onClick={() => {
                setMenu(false);
                setEditor(route === "room" ? "room" : "details");
              }}
            >
              {route === "room"
                ? "Название и тип комнаты"
                : route === "defect"
                  ? "Название дефекта"
                  : "Изменить данные документа"}
              <Icon name="pencil" />
            </Button>
            {route === "document" && (
              <Button kind="outline" disabled={busy} onClick={() => void duplicate()}>
                {busy ? "Копируем документ…" : "Дублировать документ"}
                <Icon name="copy" />
              </Button>
            )}
            <Button kind="outline" className="danger" disabled={busy} onClick={confirmDelete}>
              Удалить{" "}
              {route === "document"
                ? "документ"
                : route === "room"
                  ? "комнату"
                  : "дефект"}
              <Icon name="trash" />
            </Button>
          </div>
        </Modal>
      )}
      {dateEditing && (
        <Modal title="Дата осмотра" onClose={() => setDateEditing(false)}>
          <Field
            label="Дата осмотра"
            type="date"
            required
            value={newDoc.inspectionDate}
            onChange={(inspectionDate) => editNewDocument({ inspectionDate })}
            autoFocus
          />
          {storageStatus}
          <Button onClick={() => setDateEditing(false)}>Готово</Button>
        </Modal>
      )}
      {editor && (
        <Modal
          title={
            editor === "description"
              ? "Описание"
              : editor === "room"
                ? "Комната"
                : "Данные"
          }
          onClose={() => setEditor(null)}
        >
          <div className="stack">
            {storageStatus}
            {globalError && (
              <p role="alert" className="status error">
                {globalError}
              </p>
            )}
            {editor === "description" ? (
              <Field
                label="Описание"
                value={
                  route === "new"
                    ? newDoc.description
                    : route === "document"
                      ? d!.description
                      : route === "room"
                        ? r!.description
                        : defect!.description
                }
                multiline
                autoFocus
                onChange={(value) =>
                  route === "new"
                    ? editNewDocument({ description: value })
                    : route === "document"
                      ? edit((v) => {
                          v.description = value;
                        })
                      : route === "room"
                        ? editRoom((v) => {
                            v.description = value;
                          })
                        : editDefect((v) => {
                            v.description = value;
                          })
                }
              />
            ) : editor === "room" ? (
              <>
                <Field
                  label="Название комнаты"
                  value={r!.name}
                  onChange={(name) =>
                    editRoom((v) => {
                      v.name = name;
                    })
                  }
                />
                <label className="field">
                  <span>Тип комнаты</span>
                  <select
                    value={r!.type}
                    onChange={(e) => {
                      const type = e.target.value as RoomType;
                      setDialog({
                        title: "Изменить тип комнаты?",
                        body: "Отметки проверенных пунктов будут очищены. Фото и дефекты сохранятся.",
                        confirm: () =>
                          editRoom((v) => {
                            v.type = type;
                            v.checkedItemIds = [];
                          }),
                      });
                    }}
                  >
                    {roomTypes.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
              </>
            ) : route === "defect" ? (
              <Field
                label="Название дефекта"
                required
                value={defect!.title}
                onChange={(title) =>
                  editDefect((v) => {
                    v.title = title;
                  })
                }
              />
            ) : (
              <>
                <Field
                  label="Название документа"
                  value={d!.title}
                  onChange={(title) =>
                    edit((v) => {
                      v.title = title;
                    })
                  }
                />
                <Field
                  label="Адрес"
                  required
                  value={d!.address}
                  onChange={(address) =>
                    edit((v) => {
                      v.address = address;
                    })
                  }
                />
                <Field
                  label="Дата осмотра"
                  required
                  type="date"
                  value={d!.inspectionDate}
                  onChange={(inspectionDate) =>
                    edit((v) => {
                      v.inspectionDate = inspectionDate;
                    })
                  }
                />
              </>
            )}
            <Button
              onClick={() => {
                if (editor === "room" && r?.name.trim())
                  editRoom((v) => {
                    v.name = uniqueRoomName(v.name, s!.draft.rooms, v.id);
                  });
                setEditor(null);
              }}
            >
              Готово
            </Button>
          </div>
        </Modal>
      )}
      {addRoom && (
        <Modal title="Добавить комнату" onClose={() => setAddRoom(false)}>
          <div className="room-types">
            {roomTypes.map((t) => (
              <Button key={t} kind="outline" onClick={() => void insertRoom(t)}>
                {t}
              </Button>
            ))}
          </div>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (customRoom.trim()) void insertRoom("Комната", customRoom);
            }}
          >
            <Field
              label="Своё название"
              value={customRoom}
              onChange={setCustomRoom}
            />
            <Button disabled={!customRoom.trim()}>Добавить</Button>
          </form>
        </Modal>
      )}
      {photoTarget && (
        <Modal title="Добавить фото" onClose={() => setPhotoTarget(null)}>
          <div className="stack">
            <Button onClick={() => cameraInput.current?.click()}>
              Снять камерой
            </Button>
            <Button
              kind="outline"
              onClick={() => galleryInput.current?.click()}
            >
              Выбрать из галереи
            </Button>
          </div>
        </Modal>
      )}
      <input
        ref={galleryInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => void addFiles(e.target.files)}
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => void addFiles(e.target.files)}
      />
      {viewPhoto && viewed && (
        <Modal title="Фото" wide onClose={() => setViewPhoto(null)}>
          {storageStatus}
          {photoError && (
            <p role="alert" className="status error">
              {photoError}
            </p>
          )}
          <PhotoImage
            photo={viewed}
            className="fullscreen-photo"
            alt={viewed.caption || "Фото осмотра"}
          />
          <Field
            label="Подпись к фото"
            value={viewed.caption}
            onChange={(caption) =>
              updatePhoto(viewPhoto.target, viewPhoto.id, (p) => {
                p.caption = caption;
              })
            }
          />
          <Button
            kind="outline"
            className="danger"
            onClick={() =>
              setDialog({
                title: "Удалить фото?",
                body: "Это действие нельзя отменить.",
                danger: true,
                confirm: () => {
                  if (photoOperation.current) return;
                  const target = viewPhoto.target,
                    id = viewPhoto.id;
                  if (target === "room")
                    editRoom((v) => {
                      v.photos = v.photos.filter((p) => p.id !== id);
                    });
                  else
                    editDefect((v) => {
                      v.photos = v.photos.filter((p) => p.id !== id);
                    });
                  setViewPhoto(null);
                },
              })
            }
          >
            Удалить фото
          </Button>
        </Modal>
      )}
      {dialog && (
        <Modal title={dialog.title} onClose={() => setDialog(null)}>
          <p>{dialog.body}</p>
          <div className="stack">
            <Button autoFocus kind="outline" onClick={() => setDialog(null)}>
              Продолжить редактирование
            </Button>
            <Button
              className={dialog.danger ? "danger" : ""}
              onClick={async () => {
                const action = dialog.confirm;
                setDialog(null);
                await action?.();
              }}
            >
              {dialog.title.startsWith("Удалить")
                ? "Удалить"
                : dialog.title.startsWith("Перечитать")
                  ? "Отбросить ввод и перечитать"
                  : dialog.title.startsWith("Название")
                    ? "Отбросить ввод"
                    : "Подтвердить"}
            </Button>
          </div>
        </Modal>
      )}
    </main>
  );
}
