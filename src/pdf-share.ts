export function canSharePdf(file: File): boolean {
  try {
    return typeof navigator.share === "function" &&
      typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

// Invoke directly from the ready preview button to preserve user activation.
export async function sharePdf(file: File): Promise<"shared" | "cancelled"> {
  try {
    await navigator.share({ files: [file] });
    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    throw error;
  }
}
