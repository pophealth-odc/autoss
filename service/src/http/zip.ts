import type { ServerResponse } from 'node:http';
import { ZipArchive } from 'archiver';
import type { GalleryItem } from '../shared/contract.js';

export interface ZipEntry {
  /** Absolute path of the file to add. */
  absPath: string;
  /** Name inside the archive. */
  name: string;
}

export interface ZipFileEntry extends ZipEntry {
  item: GalleryItem;
}

/**
 * Entry names are kept to ASCII plus Latin-1 letters on purpose. Archives with other scripts in file names are valid
 * (and flagged as UTF-8), but the `tar` that ships with Windows refuses to extract them on systems with a Western code
 * page. The full titles are preserved in index.csv inside the archive.
 */
export function zipSafeSegment(text: string, maxChars = 60): string {
  const cleaned = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop accents: "café" -> "cafe"
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, maxChars).replace(/-+$/, '');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function stampOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown-time';
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Deterministic, collision-free, extraction-safe names for the gallery items. */
export function buildZipNames(items: readonly GalleryItem[]): string[] {
  const used = new Set<string>();
  return items.map((item) => {
    const label = zipSafeSegment(item.title) || zipSafeSegment(hostOf(item.finalUrl || item.url)) || 'screenshot';
    const base = `${stampOf(item.capturedAt)}_${label}`;
    let name = `${base}.png`;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base}_${n}.png`;
    used.add(name.toLowerCase());
    return name;
  });
}

function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  // Spreadsheet programs run text that starts with = + - @ as a formula; prefix such cells so they stay text.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A UTF-8 (with BOM, so Excel reads it correctly) listing of the archive's contents. */
export function buildIndexCsv(entries: ReadonlyArray<{ name: string; item: GalleryItem }>): string {
  const header = ['file', 'title', 'url', 'final_url', 'captured_at', 'width', 'height', 'status', 'http_status', 'warnings'];
  const rows = entries.map(({ name, item }) =>
    [name, item.title, item.url, item.finalUrl, item.capturedAt, item.width, item.height, item.status, item.httpStatus, item.warnings.join(' | ')]
      .map(csvCell)
      .join(','),
  );
  return '﻿' + [header.join(','), ...rows].join('\r\n') + '\r\n';
}

/**
 * Streams a ZIP archive into the response. PNG data does not compress, so entries are stored without deflate, which
 * is fast and keeps memory flat. If anything fails after the headers were sent, the connection is destroyed so the
 * download visibly fails instead of ending in a truncated archive that looks complete.
 */
export function streamZip(
  res: ServerResponse,
  entries: readonly ZipEntry[],
  extras: ReadonlyArray<{ name: string; content: string }>,
  onError: (error: Error) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const archive = new ZipArchive({ store: true });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    archive.on('error', (error: Error) => {
      onError(error);
      res.destroy(error);
      finish();
    });
    archive.on('warning', (error: Error & { code?: string }) => {
      // A source file that cannot be read must fail the whole download, not silently produce an incomplete archive.
      onError(error);
      archive.abort();
      res.destroy(error);
      finish();
    });
    res.once('close', () => {
      if (!res.writableFinished) archive.abort();
      finish();
    });
    res.once('finish', finish);

    archive.pipe(res);
    for (const entry of entries) archive.file(entry.absPath, { name: entry.name });
    for (const extra of extras) archive.append(extra.content, { name: extra.name });
    void archive.finalize().catch((error: unknown) => {
      onError(error instanceof Error ? error : new Error(String(error)));
      res.destroy();
      finish();
    });
  });
}
