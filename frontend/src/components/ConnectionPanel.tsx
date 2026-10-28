import { CircleAlert, Loader2, PlugZap, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { isLoopbackUrl } from '../api/client';
import { useApp } from '../state/app-context';
import { SetupSteps, ExternalHelp } from './SetupGuide';
import { Button, Card } from './ui';

function hostedPage(): boolean {
  return typeof location !== 'undefined' && !isLoopbackUrl(location.href);
}

/**
 * Explains, in plain words, why automation is unavailable. It renders nothing while connected, so every page can include it.
 * The wording never suggests that capturing could work while the service is unreachable.
 */
export function ConnectionPanel({ compact = false }: { compact?: boolean }) {
  const { connection, manager } = useApp();
  const { phase, problem } = connection;
  if (phase === 'connected') return null;

  if (phase === 'idle' || phase === 'connecting') {
    return (
      <Card className="p-5">
        <p role="status" className="flex items-center gap-3 text-sm text-slate-700 dark:text-slate-300">
          <Loader2 className="size-5 animate-spin text-brand-600" aria-hidden />
          Looking for the local service at <code className="font-mono">{connection.serviceUrl}</code>…
        </p>
      </Card>
    );
  }

  if (phase === 'waiting-for-permission') {
    return (
      <Card className="border-amber-300 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/40">
        <div className="flex gap-3">
          <ShieldAlert className="mt-0.5 size-6 shrink-0 text-amber-600" aria-hidden />
          <div className="space-y-2 text-sm text-amber-950 dark:text-amber-100">
            <h2 className="text-base font-semibold">Your browser may be asking for permission</h2>
            <p>
              Look near the address bar for a prompt asking whether <strong>this site</strong> may access devices on your computer, and choose <strong>Allow</strong>. This page needs it to talk to the
              service running on your own computer. Nothing is sent to the internet.
            </p>
            <p>If no prompt appears, the service may not be running yet.</p>
          </div>
        </div>
      </Card>
    );
  }

  if (phase === 'needs-token') {
    return (
      <Card className="border-amber-300 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/40">
        <div className="flex gap-3">
          <PlugZap className="mt-0.5 size-6 shrink-0 text-amber-600" aria-hidden />
          <div className="space-y-3 text-sm text-amber-950 dark:text-amber-100">
            <h2 className="text-base font-semibold">{problem === 'unauthorized' && connection.hasToken ? 'The pairing token was not accepted' : 'Pair this page with the service'}</h2>
            <p>{connection.hasToken ? 'The service is running but did not accept the token. Copy it again from the service window.' : 'The service is running. Enter its pairing token to continue. It is shown in the service window.'}</p>
            <Link to="/settings">
              <Button variant="primary" size="sm">
                Open Settings
              </Button>
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  // phase === 'failed'
  const headline: Record<string, string> = {
    unreachable: 'The local service is not reachable',
    'permission-denied': 'Your browser blocked access to your computer',
    'origin-not-allowed': 'The service does not allow this website',
    'bad-host': 'The service address is not accepted',
    'rate-limited': 'Too many wrong tokens',
    incompatible: 'This is not a compatible service',
    timeout: 'The service did not answer',
  };

  return (
    <Card className="border-red-300 p-5 dark:border-red-900">
      <div className="flex gap-3">
        <CircleAlert className="mt-0.5 size-6 shrink-0 text-red-600" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{headline[problem ?? 'unreachable'] ?? 'Not connected'}</h2>
            <p className="mt-1">{connection.message}</p>
            {connection.advice ? <p className="mt-1 font-medium text-slate-900 dark:text-slate-100">{connection.advice}</p> : null}
          </div>

          <p className="flex items-start gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            Capturing screenshots is unavailable until the service is connected. This page cannot control your browser by itself.
          </p>

          {problem === 'unreachable' || problem === 'timeout' ? (
            <>
              {!compact ? <SetupSteps /> : null}
              {hostedPage() && !compact ? (
                <p className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-700">
                  <strong>Using the hosted page and the service is running?</strong> Some browsers or company policies block websites from reaching your computer. As an alternative, run this page
                  locally with <code className="font-mono">scripts\windows\start-dev.bat</code> and open the address it prints.
                </p>
              ) : null}
            </>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void manager.connect()}>
              Try again
            </Button>
            <Link to="/settings">
              <Button size="sm">Connection settings</Button>
            </Link>
          </div>
          {!compact ? <ExternalHelp /> : null}
        </div>
      </div>
    </Card>
  );
}
