import { Photo } from "./model";

/** A batch owns a stable target; it never writes after that target disappears. */
export async function addPhotoBatch(
  files: File[],
  limit: number,
  current: () => Photo[] | undefined,
  prepare: (file: File) => Promise<Photo>,
  append: (photo: Photo) => void,
) {
  const initial = current();
  if (!initial) return { cancelled: true, errors: 0, overflow: false };
  if (initial.length + files.length > limit)
    return { cancelled: false, errors: 0, overflow: true };
  let errors = 0;
  for (const file of files) {
    if (!current()) return { cancelled: true, errors, overflow: false };
    try {
      const photo = await prepare(file);
      const target = current();
      if (!target) return { cancelled: true, errors, overflow: false };
      if (target.length >= limit)
        return { cancelled: false, errors, overflow: true };
      append(photo);
    } catch {
      errors++;
    }
  }
  return { cancelled: false, errors, overflow: false };
}
