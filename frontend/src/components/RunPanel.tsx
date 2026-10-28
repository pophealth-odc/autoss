import clsx from 'clsx';
import { CircleAlert, CircleCheck, Hourglass, ImageOff, LogIn, Play, Square, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { AutomationStatus, RunState, RunStep } from '../api/contract';
import { formatDateTime, plural, shortUrl } from '../lib/format';
import { Badge, Button, Card, CardHeader, ProgressBar } from './ui';

const STATE_LABEL: Record<RunState, string> = {
  idle: 'Ready',
  starting: 'Starting',
  running: 'Running',
  'waiting-for-login': 'Waiting for you to sign in',
  stopping: 'Stopping',
  completed: 'Finished',
  stopped: 'Stopped',
  failed: 'Failed',
};

const STEP_LABEL: Record<RunStep, string> = {
  launching: 'Starting Edge',
  navigating: 'Loading the page',
  waiting: 'Waiting for the page to settle',
  scrolling: 'Scrolling to load content',
  capturing: 'Taking the screenshot',
  saving: 'Saving the screenshot',
  pausing: 'Pausing before the next page',
};

const KIND_LABEL: Record<string, string> = {
  'invalid-url': 'Invalid address',
  blocked: 'Blocked',
  timeout: 'Timed out',
  dns: 'Address not found',
  connection: 'Connection failed',
  certificate: 'Certificate problem',
  'auth-required': 'Sign-in required',
  download: 'Download, not a page',
  navigation: 'Navigation failed',
  screenshot: 'Screenshot failed',
  'browser-closed': 'Browser closed',
  aborted: 'Stopped',
  storage: 'Could not save',
  unknown: 'Error',
};

function stateTone(state: RunState): 'green' | 'red' | 'amber' | 'blue' | 'slate' {
  switch (state) {
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    case 'stopped':
    case 'stopping':
    case 'waiting-for-login':
      return 'amber';
    case 'running':
    case 'starting':
      return 'blue';
    default:
      return 'slate';
  }
}

interface Props {
  status: AutomationStatus | null;
  connected: boolean;
  canStart: boolean;
  startHint: string | null;
  starting: boolean;
  onStart: () => void;
  onStop: () => void;
  onContinue: () => void;
  onClearGallery: () => void;
  galleryCount: number;
  stopping: boolean;
}

export function RunPanel({ status, connected, canStart, startHint, starting, onStart, onStop, onContinue, onClearGallery, galleryCount, stopping }: Props) {
  const [showFailures, setShowFailures] = useState(false);
  const active = status?.active === true;
  const waitingForLogin = status?.state === 'waiting-for-login';
  const total = status?.total ?? 0;
  const completed = status?.completed ?? 0;
  const percent = status?.percent ?? 0;
  const showProgress = status !== null && status.state !== 'idle';

  return (
    <Card>
      <CardHeader
        title="Automation"
        description={connected ? 'Start a run to capture every page in the list automatically.' : 'Unavailable until the local service is connected.'}
        actions={
          status && status.state !== 'idle' ? (
            <Badge tone={stateTone(status.state)}>{STATE_LABEL[status.state]}</Badge>
          ) : (
            <Badge tone={connected ? 'slate' : 'red'}>{connected ? 'Ready' : 'Not connected'}</Badge>
          )
        }
      />
      <div className="space-y-5 p-5">
        <div className="flex flex-wrap items-center gap-2">
          {/* The spinner is only for the moment the start request is in flight; once the run is under way the button is simply disabled. */}
          <Button variant="primary" icon={<Play className="size-4" aria-hidden />} onClick={onStart} disabled={!canStart || active} loading={starting && !active}>
            Start Automation
          </Button>
          <Button variant="danger" icon={<Square className="size-4" aria-hidden />} onClick={onStop} disabled={!connected || !active || status?.state === 'stopping'} loading={stopping}>
            Stop Automation
          </Button>
          <Button icon={<Trash2 className="size-4" aria-hidden />} onClick={onClearGallery} disabled={!connected || active || galleryCount === 0}>
            Clear Gallery
          </Button>
        </div>
        {startHint && !active ? <p className="text-sm text-slate-600 dark:text-slate-400">{startHint}</p> : null}

        {waitingForLogin ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100" role="status">
            <LogIn className="size-5 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1">
              <strong>Sign in in the Edge window</strong>, then press Continue. Capturing starts after that.
            </p>
            <Button variant="primary" size="sm" onClick={onContinue}>
              Continue
            </Button>
          </div>
        ) : null}

        {showProgress ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium text-slate-900 dark:text-slate-100" data-testid="progress-text">
                  {completed} of {total} {total === 1 ? 'page' : 'pages'} done
                  {status?.discovering ? ' (more may be found)' : ''}
                </span>
                <span className="tabular-nums text-slate-700 dark:text-slate-300" data-testid="progress-percent">
                  {percent}%
                </span>
              </div>
              <ProgressBar percent={percent} label="Pages completed" tone={status?.state === 'failed' ? 'red' : status?.state === 'completed' && status.failed === 0 ? 'green' : status?.state === 'stopped' ? 'amber' : 'brand'} indeterminate={status?.state === 'starting'} />
            </div>

            <dl className="grid gap-3 sm:grid-cols-4">
              <Stat label="Status" value={status ? STATE_LABEL[status.state] : '—'} />
              <Stat label="Successful captures" value={String(status?.succeeded ?? 0)} icon={<CircleCheck className="size-4 text-emerald-600" aria-hidden />} testId="stat-success" />
              <Stat label="Failed captures" value={String(status?.failed ?? 0)} icon={<CircleAlert className={clsx('size-4', (status?.failed ?? 0) > 0 ? 'text-red-600' : 'text-slate-400')} aria-hidden />} testId="stat-failed" />
              <Stat label="Browser" value={status?.browserVersion ? `Edge ${status.browserVersion.split('.')[0]}` : '—'} />
            </dl>

            <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-400">Current page</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-900 dark:text-slate-100" data-testid="current-url">
                {status?.currentUrl ?? (active ? '—' : 'None')}
              </p>
              {status?.currentStep ? (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300">
                  <Hourglass className="size-3.5" aria-hidden />
                  {STEP_LABEL[status.currentStep]}
                </p>
              ) : null}
            </div>

            <p role="status" aria-live="polite" className="text-sm text-slate-700 dark:text-slate-300" data-testid="status-message">
              {status?.message}
            </p>

            {status && status.failures.length > 0 ? (
              <div>
                <button type="button" className="text-sm font-medium text-brand-700 underline dark:text-blue-300" aria-expanded={showFailures} onClick={() => setShowFailures((v) => !v)}>
                  {showFailures ? 'Hide' : 'Show'} {plural(status.failures.length, 'failed page')}
                </button>
                {showFailures ? (
                  <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
                    {status.failures.map((failure, index) => (
                      <li key={`${failure.at}-${index}`} className="space-y-0.5 px-3 py-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <ImageOff className="size-4 shrink-0 text-red-600" aria-hidden />
                          <span className="break-all font-mono text-xs" title={failure.url}>
                            {shortUrl(failure.url, 80)}
                          </span>
                          <Badge tone="red">{KIND_LABEL[failure.kind] ?? failure.kind}</Badge>
                        </div>
                        <p className="pl-6 text-xs text-slate-700 dark:text-slate-300">{failure.message}</p>
                        <p className="pl-6 text-xs text-slate-500">{formatDateTime(failure.at)}</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function Stat({ label, value, icon, testId }: { label: string; value: string; icon?: React.ReactNode; testId?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
      <dt className="text-xs text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-1.5 text-base font-semibold text-slate-900 dark:text-slate-100" data-testid={testId}>
        {icon}
        {value}
      </dd>
    </div>
  );
}
