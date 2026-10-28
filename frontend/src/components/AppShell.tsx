import clsx from 'clsx';
import { Camera, Images, LayoutDashboard, Menu, Settings, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { PairingPrompt } from '../pages/SettingsPage';
import { useApp } from '../state/app-context';
import { ConnectionBadge } from './ConnectionStatus';
import { Toasts } from './Toasts';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/gallery', label: 'Gallery', icon: Images, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
] as const;

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { gallery } = useApp();
  return (
    <nav aria-label="Main" className="space-y-1">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          {...(onNavigate ? { onClick: onNavigate } : {})}
          className={({ isActive }) =>
            clsx(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
              isActive ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
            )
          }
        >
          <Icon className="size-5 shrink-0" aria-hidden />
          <span className="flex-1">{label}</span>
          {to === '/gallery' && gallery.items.length > 0 ? (
            <span className="rounded-full bg-black/10 px-2 py-0.5 text-xs tabular-nums dark:bg-white/15">{gallery.items.length}</span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <span className="flex size-9 items-center justify-center rounded-xl bg-brand-600 text-white">
        <Camera className="size-5" aria-hidden />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Screenshot Gallery</p>
        <p className="text-xs text-slate-600 dark:text-slate-400">Edge automation</p>
      </div>
    </div>
  );
}

export function AppShell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="flex min-h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg dark:focus:bg-slate-900">
        Skip to content
      </a>

      {/* Desktop and tablet sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col gap-6 border-r border-slate-200 bg-white px-3 py-5 md:flex dark:border-slate-800 dark:bg-slate-900">
        <Brand />
        <Nav />
        <div className="mt-auto border-t border-slate-200 pt-3 dark:border-slate-800">
          <ConnectionBadge />
        </div>
      </aside>

      {/* Phone-width drawer */}
      {open ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button type="button" className="absolute inset-0 bg-slate-950/60" aria-label="Close navigation" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-6 bg-white px-3 py-5 shadow-xl dark:bg-slate-900">
            <div className="flex items-center justify-between">
              <Brand />
              <button type="button" className="rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close navigation" onClick={() => setOpen(false)}>
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <Nav onNavigate={() => setOpen(false)} />
            <div className="mt-auto border-t border-slate-200 pt-3 dark:border-slate-800">
              <ConnectionBadge />
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-2.5 backdrop-blur md:hidden dark:border-slate-800 dark:bg-slate-900/90">
          <button type="button" className="rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(true)}>
            <Menu className="size-5" aria-hidden />
          </button>
          <span className="text-sm font-semibold">Screenshot Gallery</span>
          <div className="ml-auto">
            <ConnectionBadge className="py-1" />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
      <PairingPrompt />
      <Toasts />
    </div>
  );
}
