import { ChevronLeft, ChevronRight, Download, ExternalLink, ImageOff, Trash2, X } from 'lucide-react';
import { useEffect } from 'react';
import type { ServiceClient } from '../api/client';
import type { GalleryItem } from '../api/contract';
import { formatBytes, formatDateTime, formatDimensions } from '../lib/format';
import { useBlobUrl } from '../state/use-blob-url';
import { Badge, Button, IconButton, Modal, Spinner } from './ui';

interface Props {
  item: GalleryItem | null;
  client: ServiceClient;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onDownload: (item: GalleryItem) => void;
  onDelete: (item: GalleryItem) => void;
}

export function PreviewModal({ item, client, hasPrevious, hasNext, onPrevious, onNext, onClose, onDownload, onDelete }: Props) {
  const image = useBlobUrl(client, item?.id ?? null, 'image', item !== null);

  useEffect(() => {
    if (!item) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && hasPrevious) onPrevious();
      if (event.key === 'ArrowRight' && hasNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, hasPrevious, hasNext, onPrevious, onNext]);

  const label = item ? item.title || item.url || item.filename : '';

  return (
    <Modal open={item !== null} onClose={onClose} wide {...(item ? { title: label.length > 90 ? `${label.slice(0, 89)}…` : label } : {})}>
      {item ? (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pb-3 pt-1 text-xs text-slate-600 dark:text-slate-400">
            <a href={item.finalUrl || item.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 truncate text-brand-700 hover:underline dark:text-blue-300">
              <span className="truncate">{item.url}</span>
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </a>
            <time dateTime={item.capturedAt}>{formatDateTime(item.capturedAt)}</time>
            <span>{formatDimensions(item.width, item.height)}</span>
            <span>{formatBytes(item.bytes)}</span>
            {item.status === 'warning' ? <Badge tone="amber">{item.warnings[0] ?? 'Captured with a warning'}</Badge> : null}
          </div>

          <div className="relative min-h-40 flex-1 overflow-auto bg-slate-100 dark:bg-slate-950" tabIndex={0} aria-label="Screenshot, scrollable">
            {image.url ? (
              <img src={image.url} alt={`Full screenshot of ${label}`} className="mx-auto block h-auto max-w-full" />
            ) : image.failed ? (
              <div className="flex h-60 flex-col items-center justify-center gap-2 text-sm text-slate-600">
                <ImageOff className="size-8" aria-hidden />
                The image could not be loaded.
              </div>
            ) : (
              <div className="flex h-60 items-center justify-center">
                <Spinner label="Loading image…" />
              </div>
            )}
            {hasPrevious ? (
              <IconButton label="Previous screenshot" onClick={onPrevious} className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/90 shadow dark:bg-slate-900/90">
                <ChevronLeft className="size-5" aria-hidden />
              </IconButton>
            ) : null}
            {hasNext ? (
              <IconButton label="Next screenshot" onClick={onNext} className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/90 shadow dark:bg-slate-900/90">
                <ChevronRight className="size-5" aria-hidden />
              </IconButton>
            ) : null}
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">
            <Button icon={<Download className="size-4" aria-hidden />} onClick={() => onDownload(item)}>
              Download
            </Button>
            <Button variant="danger" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => onDelete(item)}>
              Delete
            </Button>
            <Button icon={<X className="size-4" aria-hidden />} onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
