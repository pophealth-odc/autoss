import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { useApp } from '../state/app-context';
import type { ConnectionPhase } from '../state/connection';

const LABELS: Record<ConnectionPhase, { text: string; dot: string }> = {
  idle: { text: 'Not connected', dot: 'bg-slate-400' },
  connecting: { text: 'Connecting…', dot: 'bg-amber-500 animate-pulse' },
  'waiting-for-permission': { text: 'Waiting for permission', dot: 'bg-amber-500 animate-pulse' },
  'needs-token': { text: 'Pairing needed', dot: 'bg-amber-500' },
  connected: { text: 'Connected', dot: 'bg-emerald-500' },
  failed: { text: 'Not connected', dot: 'bg-red-500' },
};

/** Compact indicator for the sidebar and the top bar. */
export function ConnectionBadge({ className }: { className?: string }) {
  const { connection } = useApp();
  const { text, dot } = LABELS[connection.phase];
  return (
    <Link
      to="/settings"
      className={clsx('flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800', className)}
      aria-label={`Connection status: ${text}. Open settings.`}
    >
      <span className={clsx('size-2.5 shrink-0 rounded-full', dot)} aria-hidden />
      <span className="min-w-0">
        <span className="block truncate font-medium text-slate-800 dark:text-slate-100" data-testid="connection-label">
          {text}
        </span>
        <span className="block truncate text-xs text-slate-600 dark:text-slate-400">
          {connection.phase === 'connected' && connection.live ? 'Live updates on' : connection.serviceUrl.replace(/^https?:\/\//, '')}
        </span>
      </span>
    </Link>
  );
}
