import { Inspection, StorageError } from "./model";
import { Repository, storageError } from "./repository";
export class DraftSession {
  draft: Inspection;
  error: StorageError | null = null;
  saving = false;
  private revision: number;
  private generation = 0;
  private confirmed = 0;
  private running: Promise<void> | null = null;
  private paused = false;
  private saved: Inspection;
  constructor(
    private repo: Repository,
    document: Inspection,
    private changed: () => void,
  ) {
    this.draft = structuredClone(document);
    this.saved = structuredClone(document);
    this.revision = document.revision;
  }
  get dirty() {
    return this.generation !== this.confirmed;
  }
  edit(mutation: (d: Inspection) => void) {
    const next = structuredClone(this.draft);
    mutation(next);
    this.draft = next;
    this.generation++;
    if (this.error?.code === "invalid") this.error = null;
    this.changed();
    if (!this.error) void this.run();
  }
  private run(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async drain() {
    this.saving = true;
    this.changed();
    try {
      while (this.dirty && !this.error && !this.paused) {
        const gen = this.generation,
          snapshot = structuredClone(this.draft);
        const saved = await this.repo.updateDocument(
          snapshot.id,
          this.revision,
          (d) => Object.assign(d, snapshot),
        );
        this.revision = saved.revision;
        this.saved = structuredClone(saved);
        this.confirmed = gen;
        this.draft = {
          ...this.draft,
          revision: saved.revision,
          updatedAt: saved.updatedAt,
        };
        this.changed();
      }
    } catch (e) {
      this.error = storageError(e);
    } finally {
      this.saving = false;
      this.changed();
    }
  }
  async flush() {
    await this.run();
    if (this.error) throw this.error;
    if (this.dirty) await this.flush();
  }
  async retry() {
    if (this.error?.code === "conflict") throw this.error;
    this.error = null;
    await this.flush();
  }
  async discardDefect(roomId: string, defectId: string, isNew: boolean) {
    // Stop queued snapshots first; an already-started transaction must settle.
    this.paused = true;
    await this.running;
    const savedDefect = this.saved.rooms
      .find((r) => r.id === roomId)
      ?.defects.find((f) => f.id === defectId);
    this.edit((draft) => {
      const room = draft.rooms.find((r) => r.id === roomId);
      if (!room) return;
      room.defects = room.defects.filter((f) => f.id !== defectId);
      if (!isNew && savedDefect) {
        const index = this.saved.rooms
          .find((r) => r.id === roomId)!
          .defects.findIndex((f) => f.id === defectId);
        room.defects.splice(index, 0, structuredClone(savedDefect));
      }
    });
    this.paused = false;
    await this.retry();
  }
  async reload() {
    const saved = await this.repo.getDocument(this.draft.id);
    this.draft = saved;
    this.saved = structuredClone(saved);
    this.revision = saved.revision;
    this.generation = 0;
    this.confirmed = 0;
    this.error = null;
    this.changed();
  }
}
