/**
 * Trigger a browser download of a Blob under a given filename.
 *
 * The DOM-coupled half of the export path (the pure filename half lives in
 * core's `exportFilename`): it wraps the Blob in an object URL, points a
 * programmatic `<a download>` at it, clicks it to start the save, and then
 * revokes the URL so the Blob can be garbage-collected. This is the reusable
 * "download this Blob as a file" scaffold every export consumer shares — the PNG
 * path here and the SVG path next both hand it a Blob + a name from
 * `exportFilename`.
 *
 * It lives in the Studio (not core) precisely because it touches the DOM:
 * `URL.createObjectURL`, an anchor element, and `revokeObjectURL`. Core stays
 * headless.
 *
 * The anchor is never attached to the document — a programmatic `click()` works
 * on a detached element, so there is nothing to clean up but the object URL,
 * which is revoked synchronously after the click.
 *
 * @param blob - The file contents to download.
 * @param filename - The name to save the file under (e.g. from `exportFilename`).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
