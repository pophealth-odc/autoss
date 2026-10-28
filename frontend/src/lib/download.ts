/** Saves a Blob through the browser's normal download mechanism. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke later: some browsers start the download asynchronously.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
