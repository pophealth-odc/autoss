import clsx from 'clsx';
import { AlertTriangle, Download, Eye, ImageOff, Trash2 } from 'lucide-react';
import { memo } from 'react';
import type { ServiceClient } from '../api/client';
import type { GalleryItem } from '../api/contract';
import { formatBytes, formatDateTime, formatDimensions, hostOf } from '../lib/format';
import { useBlobUrl } from '../state/use-blob-url';
import { Badge, IconButton } from './ui';

interface Props {
  item: GalleryItem;
  client: ServiceClient;
  selected: boolean;
  busy: boolean;
  onToggle: (id: string) => void;
  onPreview: (item: GalleryItem) => void;
  onDownload: (item: GalleryItem) => void;
  onDelete: (item: GalleryItem) => void;
}

function GalleryCardInner({ item, client, selected, busy, onToggle, onPreview, onDownload, onDelete }: Props) {
  const thumb = useBlobUrl(client, item.id, 'thumbnail');
  const label = item.title || hostOf(item.finalUrl || item.url) || item.filename;

  return (
    <article
      className={clsx(
        'group flex flex-col overflow-hidden rounded-xl border bg-white shadow-sm transition-shadow hover:shadow-md dark:bg-slate-900',
        selected ? 'border-brand-500 ring-2 ring-brand-500' : 'border-slate-200 dark:border-slate-800',
      )}
      aria-label={label}
    >
      <div className="relative aspect-[16/10] bg-slate-100 dark:bg-slate-800">
        <button type="button" onClick={() => onPreview(item)} className="absolute inset-0 block size-full overflow-hidden" aria-label={`Preview ${label}`}>
          {thumb.url ? (
            <img src={thumb.url} alt={`Screenshot of ${label}`} loading="lazy" decoding="async" className="size-full object-cover object-left-top" draggable={false} />
          ) : thumb.failed ? (
            <span className="flex size-full flex-col items-center justify-center gap-1 text-xs text-slate-500">
              <ImageOff className="size-6" aria-hidden />
              Could not load
            </span>
          ) : (
            <span className="skeleton block size-full" aria-hidden />
          )}
        </button>
        {/* A solid pill with a shadow keeps the checkbox readable over any page content. */}
        <label className="absolute bottom-2 left-2 flex size-8 cursor-pointer items-center justify-center rounded-lg bg-white shadow-md ring-1 ring-slate-400 dark:bg-slate-900 dark:ring-slate-500">
          <input type="checkbox" checked={selected} onChange={() => onToggle(item.id)} className="size-4 rounded border-slate-400 text-brand-600 focus:ring-brand-500" aria-label={`Select ${label}`} />
        </label>
        {item.status === 'warning' ? (
          <span className="absolute right-2 top-2">
            <Badge tone="amber">
              <AlertTriangle className="size-3" aria-hidden />
              {item.httpStatus !== null && item.httpStatus >= 400 ? `HTTP ${item.httpStatus}` : 'Warning'}
            </Badge>
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100" title={item.title || undefined}>
          {item.title || <span className="font-normal italic text-slate-500">Untitled page</span>}
        </h3>
        <a href={item.finalUrl || item.url} target="_blank" rel="noreferrer noopener" className="truncate text-xs text-brand-700 hover:underline dark:text-blue-300" title={item.url}>
          {item.url || item.finalUrl || 'Address unknown'}
        </a>
        <dl className="mt-1 space-y-0.5 text-xs text-slate-600 dark:text-slate-400">
          <div className="flex justify-between gap-2">
            <dt className="sr-only">Captured</dt>
            <dd>
              <time dateTime={item.capturedAt}>{formatDateTime(item.capturedAt, true)}</time>
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="sr-only">Size</dt>
            <dd>
              {formatDimensions(item.width, item.height)} · {formatBytes(item.bytes)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="flex items-center justify-end gap-0.5 border-t border-slate-200 px-2 py-1.5 dark:border-slate-800">
        <IconButton label={`Preview ${label}`} onClick={() => onPreview(item)}>
          <Eye className="size-4" aria-hidden />
        </IconButton>
        <IconButton label={`Download ${label}`} onClick={() => onDownload(item)} disabled={busy}>
          <Download className="size-4" aria-hidden />
        </IconButton>
        <IconButton label={`Delete ${label}`} onClick={() => onDelete(item)} disabled={busy} className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50">
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
      </div>
    </article>
  );
}

export const GalleryCard = memo(GalleryCardInner);
