import { Download, ExternalLink, KeyRound, Terminal } from 'lucide-react';
import { CodeBlock } from './ui';

/** Steps for getting the local service running. Shown when the service cannot be reached and on the empty gallery. */
export function SetupSteps() {
  return (
    <ol className="space-y-4 text-sm text-slate-700 dark:text-slate-300">
      <li className="flex gap-3">
        <Download className="mt-0.5 size-5 shrink-0 text-brand-600" aria-hidden />
        <div className="min-w-0 space-y-1.5">
          <p className="font-medium text-slate-900 dark:text-slate-100">1. Install the local service (once)</p>
          <p>
            This page cannot control your browser by itself. A small program on your computer does the work. Download the project, then double-click{' '}
            <strong>install.bat</strong> in the <em>scripts\windows</em> folder. It needs Node.js 22 or newer and Microsoft Edge.
          </p>
        </div>
      </li>
      <li className="flex gap-3">
        <Terminal className="mt-0.5 size-5 shrink-0 text-brand-600" aria-hidden />
        <div className="min-w-0 space-y-1.5">
          <p className="font-medium text-slate-900 dark:text-slate-100">2. Start it</p>
          <p>
            Double-click <strong>start-service.bat</strong>, or run this in the project folder. Keep the window open while you use the gallery.
          </p>
          <CodeBlock label="Command to start the service">{'scripts\\windows\\start-service.bat'}</CodeBlock>
        </div>
      </li>
      <li className="flex gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-brand-600" aria-hidden />
        <div className="min-w-0 space-y-1.5">
          <p className="font-medium text-slate-900 dark:text-slate-100">3. Pair this page with it</p>
          <p>
            The service window prints a <strong>pairing token</strong>. Paste it into <strong>Settings</strong>. If your browser asks whether this site may access devices on your computer,
            choose <strong>Allow</strong>.
          </p>
        </div>
      </li>
    </ol>
  );
}

export function ExternalHelp() {
  return (
    <p className="text-xs text-slate-600 dark:text-slate-400">
      Need Node.js?{' '}
      <a className="inline-flex items-center gap-1 text-brand-700 underline dark:text-blue-300" href="https://nodejs.org/en/download" target="_blank" rel="noreferrer noopener">
        nodejs.org <ExternalLink className="size-3" aria-hidden />
      </a>
      . Need Edge?{' '}
      <a className="inline-flex items-center gap-1 text-brand-700 underline dark:text-blue-300" href="https://www.microsoft.com/edge" target="_blank" rel="noreferrer noopener">
        microsoft.com/edge <ExternalLink className="size-3" aria-hidden />
      </a>
    </p>
  );
}
