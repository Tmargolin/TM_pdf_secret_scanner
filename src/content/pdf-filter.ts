// Which files are scanned (DESIGN.md §3, content script steps 1–2).
// A PDF is recognised by its first bytes ("%PDF-"), not by name or MIME type –
// both are only hints and are easy to get wrong either way.

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** True if the file starts with "%PDF-". Reads 5 bytes only; never throws. */
export async function isPdf(file: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, PDF_MAGIC.length).arrayBuffer());
    return PDF_MAGIC.every((byte, i) => head[i] === byte);
  } catch {
    return false; // unreadable (e.g. the file was deleted meanwhile)
  }
}

/** The PDFs among `files`, in their original order. */
export async function keepPdfs(files: readonly File[]): Promise<File[]> {
  const checks = await Promise.all(files.map((file) => isPdf(file)));
  return files.filter((_, i) => checks[i]);
}
