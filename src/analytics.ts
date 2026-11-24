export type LocalEvent =
  "document_created" | "preview_opened" | "pdf_downloaded";
const counts: Record<LocalEvent, number> = {
  document_created: 0,
  preview_opened: 0,
  pdf_downloaded: 0,
};
export function record(event: LocalEvent) {
  if (Object.hasOwn(counts, event)) counts[event]++;
}
