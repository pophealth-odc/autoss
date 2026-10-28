import { Archive, CheckSquare, Download, Images, PackageOpen, RefreshCw, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { GalleryItem } from '../api/contract';
import { ConnectionPanel } from '../components/ConnectionPanel';
import { GalleryCard } from '../components/GalleryCard';
import { PreviewModal } from '../components/PreviewModal';
import { SetupSteps } from '../components/SetupGuide';
import { Button, Card, CardHeader, ConfirmDialog, EmptyState, Spinner, inputClass } from '../components/ui';
import { saveBlob } from '../lib/download';
import { formatBytes, plural, safeFileName } from '../lib/format';
import { loadSort, saveSort, useApp, type SortKey } from '../state/app-context';

export function sortItems(items: readonly GalleryItem[], sort: SortKey): GalleryItem[] {
  const copy = [...items];
  switch (sort) {
    case 'oldest':
      return copy.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    case 'title':
      return copy.sort((a, b) => {
        // Untitled pages sort last so they do not crowd the top of an A-Z list.
        if (!a.title !== !b.title) return a.title ? -1 : 1;
        const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
        return byTitle !== 0 ? byTitle : b.capturedAt.localeCompare(a.capturedAt);
      });
    case 'newest':
    default:
      return copy.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }
}

type Pending = { kind: 'one'; item: GalleryItem } | { kind: 'selected' } | { kind: 'all' } | null;

export function GalleryPage() {
  const { connection, manager, gallery, status, notify, reportError, refreshGallery, removeFromGallery } = useApp();
  const connected = connection.phase === 'connected';
  const [sort, setSortState] = useState<SortKey>(loadSort);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [zipping, setZipping] = useState(false);

  const sorted = useMemo(() => sortItems(gallery.items, sort), [gallery.items, sort]);
  const setSort = (next: SortKey) => {
    setSortState(next);
    saveSort(next);
  };

  // Drop selections for screenshots that no longer exist (deleted here or elsewhere).
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const ids = new Set(gallery.items.map((i) => i.id));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
    setPreviewId((id) => (id !== null && !gallery.items.some((i) => i.id === id) ? null : id));
  }, [gallery.items]);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = sorted.length > 0 && selected.size === sorted.length;
  const previewIndex = previewId === null ? -1 : sorted.findIndex((i) => i.id === previewId);
  const previewItem = previewIndex >= 0 ? (sorted[previewIndex] ?? null) : null;

  const downloadOne = useCallback(
    async (item: GalleryItem) => {
      setBusy(true);
      try {
        const { blob, filename } = await manager.client.download(item.id);
        saveBlob(blob, filename ?? safeFileName(item.filename, 'screenshot.png'));
      } catch (error) {
        reportError(error, 'The download failed.');
      } finally {
        setBusy(false);
      }
    },
    [manager, reportError],
  );

  const downloadZip = useCallback(
    async (ids: string[] | null) => {
      setZipping(true);
      try {
        const { blob, filename } = await manager.client.downloadZip(ids);
        saveBlob(blob, filename ?? 'screenshots.zip');
        notify('success', `Downloaded ${formatBytes(blob.size)} as a ZIP file.`);
      } catch (error) {
        reportError(error, 'The ZIP file could not be created.');
      } finally {
        setZipping(false);
      }
    },
    [manager, notify, reportError],
  );

  const confirmDelete = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'one') {
        await manager.client.deleteOne(pending.item.id);
        removeFromGallery([pending.item.id]);
        notify('success', 'Screenshot deleted.');
        if (previewId === pending.item.id) setPreviewId(null);
      } else if (pending.kind === 'selected') {
        const ids = [...selected];
        const result = await manager.client.deleteMany(ids);
        removeFromGallery(ids);
        setSelected(new Set());
        notify('success', `Deleted ${plural(result.deleted, 'screenshot')}.`);
      } else {
        const result = await manager.client.clearGallery();
        removeFromGallery(gallery.items.map((i) => i.id));
        setSelected(new Set());
        notify('success', `Gallery cleared (${plural(result.deleted, 'screenshot')} deleted).`);
      }
      setPending(null);
    } catch (error) {
      reportError(error, 'The screenshots could not be deleted.');
      void refreshGallery();
    } finally {
      setBusy(false);
    }
  }, [pending, manager, selected, previewId, gallery.items, removeFromGallery, notify, reportError, refreshGallery]);

  const running = status?.active === true;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">Gallery</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Screenshots saved on your computer by the local service. They never leave it.</p>
      </header>

      <ConnectionPanel compact />

      {connected && gallery.loaded && gallery.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Images className="size-7" aria-hidden />}
            title="No screenshots yet"
            action={
              <Link to="/">
                <Button variant="primary">Go to Dashboard</Button>
              </Link>
            }
          >
            <p>Add some web addresses on the Dashboard and press <strong>Start Automation</strong>. Each page is captured automatically and appears here as soon as it is saved.</p>
          </EmptyState>
        </Card>
      ) : null}

      {!connected && gallery.items.length === 0 ? (
        <Card>
          <CardHeader title="Set up the local service" description="Screenshots are stored and served by a small program on your computer." />
          <div className="p-5">
            <SetupSteps />
          </div>
        </Card>
      ) : null}

      {gallery.items.length > 0 ? (
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <Button size="sm" icon={allSelected ? <CheckSquare className="size-4" aria-hidden /> : <Square className="size-4" aria-hidden />} onClick={() => setSelected(allSelected ? new Set() : new Set(sorted.map((i) => i.id)))}>
              {allSelected ? 'Select none' : 'Select all'}
            </Button>
            <span className="text-sm text-slate-700 dark:text-slate-300" aria-live="polite" data-testid="selection-count">
              {selected.size > 0 ? `${selected.size} of ${gallery.items.length} selected` : `${plural(gallery.items.length, 'screenshot')} · ${formatBytes(gallery.totalBytes)}`}
            </span>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <span className="whitespace-nowrap">Sort by</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={`${inputClass} w-auto py-1.5`} aria-label="Sort by">
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="title">Page title (A–Z)</option>
                </select>
              </label>
              <Button size="sm" icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void refreshGallery()} disabled={!connected || gallery.loading}>
                Refresh
              </Button>
              <Button size="sm" icon={<Download className="size-4" aria-hidden />} onClick={() => void downloadZip([...selected])} disabled={!connected || selected.size === 0} loading={zipping}>
                Download selected
              </Button>
              <Button size="sm" icon={<Archive className="size-4" aria-hidden />} onClick={() => void downloadZip(null)} disabled={!connected} loading={zipping}>
                Download all (ZIP)
              </Button>
              <Button size="sm" variant="danger" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setPending({ kind: 'selected' })} disabled={!connected || selected.size === 0 || running}>
                Delete selected
              </Button>
              <Button size="sm" variant="danger" icon={<PackageOpen className="size-4" aria-hidden />} onClick={() => setPending({ kind: 'all' })} disabled={!connected || running}>
                Clear all
              </Button>
            </div>
          </div>

          {!connected ? (
            <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              The service is not connected, so thumbnails and downloads are unavailable until it is.
            </p>
          ) : null}
          {running ? <p className="border-b border-slate-200 px-4 py-2 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-300">A run is in progress. New screenshots appear automatically; deleting is paused until it ends.</p> : null}

          <ul className="grid gap-4 p-4 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]" aria-label="Screenshots">
            {sorted.map((item) => (
              <li key={item.id} className="min-w-0">
                <GalleryCard
                  item={item}
                  client={manager.client}
                  selected={selected.has(item.id)}
                  busy={busy || !connected}
                  onToggle={toggle}
                  onPreview={(it) => setPreviewId(it.id)}
                  onDownload={(it) => void downloadOne(it)}
                  onDelete={(it) => setPending({ kind: 'one', item: it })}
                />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {connected && !gallery.loaded && gallery.loading ? (
        <div className="py-10 text-center">
          <Spinner label="Loading the gallery…" />
        </div>
      ) : null}
      {gallery.error && connected ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{gallery.error}</p> : null}

      <PreviewModal
        item={previewItem}
        client={manager.client}
        hasPrevious={previewIndex > 0}
        hasNext={previewIndex >= 0 && previewIndex < sorted.length - 1}
        onPrevious={() => setPreviewId(sorted[previewIndex - 1]?.id ?? null)}
        onNext={() => setPreviewId(sorted[previewIndex + 1]?.id ?? null)}
        onClose={() => setPreviewId(null)}
        onDownload={(it) => void downloadOne(it)}
        onDelete={(it) => setPending({ kind: 'one', item: it })}
      />

      <ConfirmDialog
        open={pending !== null}
        busy={busy}
        title={pending?.kind === 'all' ? 'Clear the whole gallery?' : pending?.kind === 'selected' ? `Delete ${plural(selected.size, 'screenshot')}?` : 'Delete this screenshot?'}
        message={
          pending?.kind === 'all' ? (
            <p>
              This permanently deletes all <strong>{plural(gallery.items.length, 'screenshot')}</strong> and their image files from your computer. This cannot be undone.
            </p>
          ) : pending?.kind === 'selected' ? (
            <p>The selected screenshots and their image files will be permanently deleted from your computer. This cannot be undone.</p>
          ) : (
            <p>
              <strong>{pending?.kind === 'one' ? pending.item.title || pending.item.url : ''}</strong> and its image file will be permanently deleted from your computer. This cannot be undone.
            </p>
          )
        }
        confirmLabel={pending?.kind === 'all' ? 'Clear gallery' : 'Delete'}
        onConfirm={() => void confirmDelete()}
        onCancel={() => (busy ? undefined : setPending(null))}
      />
    </div>
  );
}
