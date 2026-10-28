import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AutomationForm } from '../components/AutomationForm';
import { ConnectionPanel } from '../components/ConnectionPanel';
import { RunPanel } from '../components/RunPanel';
import { Button, Card, CardHeader, ConfirmDialog } from '../components/ui';
import { ServiceError } from '../api/errors';
import { adaptRequest, explainUnknownSetting, isUnknownSettingError } from '../lib/compat';
import { buildRequest, isFormState, mergeForm, toSavedForm, type FormIssue, type FormState, type SavedForm } from '../lib/form';
import { KEYS, loadJson, saveJson } from '../lib/storage';
import { plural } from '../lib/format';
import { useApp } from '../state/app-context';

export function DashboardPage() {
  const { connection, manager, status, gallery, notify, clearToasts, reportError, refreshGallery, applyStatus } = useApp();
  const connected = connection.phase === 'connected';
  const active = status?.active === true;

  const [form, setForm] = useState<FormState>(() => mergeForm(loadJson<SavedForm | null>(KEYS.form, null, (v): v is SavedForm => v === null || isFormState(v))));
  const [serverIssues, setServerIssues] = useState<FormIssue[]>([]);
  const [showIssues, setShowIssues] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    saveJson(KEYS.form, toSavedForm(form));
  }, [form]);

  const built = useMemo(() => buildRequest(form), [form]);
  const issues = showIssues ? [...built.issues, ...serverIssues] : serverIssues;

  const update = useCallback((patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setServerIssues([]);
  }, []);

  const clearUrls = useCallback(() => {
    setForm((current) => ({ ...current, initialUrl: '', urlText: '' }));
    setShowIssues(false);
    setServerIssues([]);
  }, []);

  const start = useCallback(async () => {
    setShowIssues(true);
    setServerIssues([]);
    const result = buildRequest(form);
    if (!result.request) {
      notify('error', result.issues[0]?.message ?? 'Check the settings and try again.');
      return;
    }
    // The page and the service are updated separately, so the running service may be older than this page.
    const adapted = adaptRequest(result.request, connection.health);
    if (adapted.blocked) {
      notify('error', adapted.blocked);
      return;
    }
    setStarting(true);
    clearToasts(); // results of the previous run should not linger over this one
    try {
      applyStatus(await manager.client.start(adapted.request));
      if (result.parse.duplicates > 0) notify('info', `${plural(result.parse.duplicates, 'duplicate address', 'duplicate addresses')} removed.`);
    } catch (error) {
      if (error instanceof ServiceError && isUnknownSettingError(error.code, error.message)) {
        // Say what is actually wrong - the service needs a restart - instead of showing its raw validation message.
        notify('error', explainUnknownSetting(error.message));
        return;
      }
      if (error instanceof ServiceError && error.code === 'validation_failed' && Array.isArray(error.details)) {
        const mapped: FormIssue[] = [];
        for (const detail of error.details as Array<{ field?: string; message?: string }>) {
          const field = detail.field ?? '';
          mapped.push({ field: field.startsWith('urls') ? 'urls' : ((field as keyof FormState) || 'urls'), message: detail.message ?? error.message });
        }
        setServerIssues(mapped);
      }
      reportError(error, 'The run could not be started.');
    } finally {
      setStarting(false);
    }
  }, [form, manager, connection.health, notify, clearToasts, reportError, applyStatus]);

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      await manager.client.stop();
    } catch (error) {
      reportError(error, 'The run could not be stopped.');
    } finally {
      setStopping(false);
    }
  }, [manager, reportError]);

  const continueRun = useCallback(async () => {
    try {
      await manager.client.continueRun();
    } catch (error) {
      reportError(error, 'Could not continue.');
    }
  }, [manager, reportError]);

  const clearGallery = useCallback(async () => {
    setClearing(true);
    try {
      const result = await manager.client.clearGallery();
      notify('success', `Gallery cleared (${plural(result.deleted, 'screenshot')} deleted).`);
      setConfirmClear(false);
      await refreshGallery();
    } catch (error) {
      reportError(error, 'The gallery could not be cleared.');
    } finally {
      setClearing(false);
    }
  }, [manager, notify, refreshGallery, reportError]);

  const startHint = !connected
    ? 'Connect to the local service first. Nothing can be captured without it.'
    : built.urls.length === 0
      ? 'Add at least one web address to begin.'
      : built.issues.length > 0 && showIssues
        ? 'Fix the highlighted settings, then start again.'
        : null;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Capture screenshots of a list of web pages with Microsoft Edge, saved on your computer.</p>
      </header>

      <ConnectionPanel />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="order-2 xl:order-1">
          <AutomationForm form={form} onChange={update} issues={issues} disabled={active} urlCount={built.urls.length} onClearUrls={clearUrls} outputRoot={connection.info?.screenshotsDir ?? null} />
        </div>
        <div className="order-1 space-y-5 xl:order-2">
          <RunPanel
            status={status}
            connected={connected}
            canStart={connected && !starting}
            startHint={startHint}
            starting={starting}
            stopping={stopping}
            onStart={() => void start()}
            onStop={() => void stop()}
            onContinue={() => void continueRun()}
            onClearGallery={() => setConfirmClear(true)}
            galleryCount={gallery.items.length}
          />
          <Card>
            <CardHeader title="Latest screenshots" actions={<Link to="/gallery"><Button size="sm">Open gallery</Button></Link>} />
            <div className="p-5 text-sm text-slate-700 dark:text-slate-300">
              {gallery.items.length === 0 ? (
                <p>Nothing captured yet. Screenshots appear in the gallery as soon as each page is saved.</p>
              ) : (
                <p>
                  <strong>{plural(gallery.items.length, 'screenshot')}</strong> saved on your computer. The most recent: <em>{gallery.items[0]?.title || gallery.items[0]?.url}</em>
                </p>
              )}
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        busy={clearing}
        title="Clear the whole gallery?"
        message={
          <p>
            This permanently deletes all <strong>{plural(gallery.items.length, 'screenshot')}</strong> and their image files from your computer. This cannot be undone.
          </p>
        }
        confirmLabel="Clear gallery"
        onConfirm={() => void clearGallery()}
        onCancel={() => (clearing ? undefined : setConfirmClear(false))}
      />
    </div>
  );
}
