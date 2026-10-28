import clsx from 'clsx';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useApp } from '../state/app-context';

const STYLES = {
  success: { icon: CircleCheck, box: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100' },
  error: { icon: CircleAlert, box: 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100' },
  warning: { icon: TriangleAlert, box: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100' },
  info: { icon: Info, box: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100' },
} as const;

/** Notifications. Errors are announced assertively; the rest politely. */
export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => {
        const { icon: Icon, box } = STYLES[toast.level];
        return (
          <div
            key={toast.id}
            role={toast.level === 'error' ? 'alert' : 'status'}
            className={clsx('pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border px-4 py-3 shadow-lg', box)}
          >
            <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1 text-sm">{toast.message}</p>
            <button type="button" onClick={() => dismissToast(toast.id)} className="-m-1 rounded p-1 opacity-70 hover:opacity-100" aria-label="Dismiss notification">
              <X className="size-4" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
