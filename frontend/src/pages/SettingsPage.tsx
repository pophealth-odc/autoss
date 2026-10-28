import { CircleCheck, FolderOpen, Moon, Monitor, RefreshCw, ShieldCheck, Sun, Trash2, Unplug } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { DEFAULT_SERVICE_URL, type ProfileInfo } from '../api/contract';
import { ConnectionPanel } from '../components/ConnectionPanel';
import { SetupSteps } from '../components/SetupGuide';
import { Badge, Button, Card, CardHeader, ConfirmDialog, Field, inputClass, Modal, Toggle } from '../components/ui';
import { formatBytes, formatDateTime } from '../lib/format';
import { useTheme, type ThemeChoice } from '../lib/theme';
import { useApp } from '../state/app-context';
import { isLoopbackUrl } from '../api/client';
import { isPageOrigin, pageServesService } from '../api/same-origin';

/** Asks before accepting a pairing link. Mounted once at the top of the app so it appears wherever the link lands. */
export function PairingPrompt() {
  const { pendingPairing, clearPendingPairing, manager, notify } = useApp();
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!pendingPairing) return null;

  const accept = async () => {
    setBusy(true);
    const error = await manager.configure({
      serviceUrl: pendingPairing.serviceUrl ?? manager.getState().serviceUrl,
      token: pendingPairing.token,
      rememberToken: remember,
    });
    setBusy(false);
    if (error) notify('error', error);
    else notify('success', 'Pairing details saved. Connecting…');
    clearPendingPairing();
  };

  return (
    <Modal open onClose={clearPendingPairing} title="Pair with the local service?">
      <div className="space-y-4 px-5 py-4 text-sm text-slate-700 dark:text-slate-300">
        <p>
          This link contains the details of a service on <strong>your own computer</strong>:
        </p>
        <p className="break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs dark:bg-slate-800">{pendingPairing.serviceUrl ?? manager.getState().serviceUrl}</p>
        <p>Only continue if you started the link from your own service window. Anyone who has the token can control your screenshot service.</p>
        <Toggle id="pair-remember" checked={remember} onChange={setRemember} label="Remember the token on this device" description="Otherwise it is forgotten when you close this tab." />
        <div className="flex justify-end gap-2">
          <Button onClick={clearPendingPairing} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void accept()} loading={busy}>
            Pair
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ConnectionCard() {
  const { connection, manager, notify } = useApp();
  const uid = useId();
  const [serviceUrl, setServiceUrl] = useState(connection.serviceUrl);
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(connection.rememberToken);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const connected = connection.phase === 'connected';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    // An empty field keeps the saved token; typing a new one replaces it.
    const problem = await manager.configure({ serviceUrl, token: token.trim() !== '' ? token : undefined, rememberToken: remember });
    setSaving(false);
    setError(problem);
    if (!problem) {
      setToken('');
      notify('info', 'Connecting…');
    }
  };

  return (
    <Card>
      <CardHeader
        title="Local service connection"
        description="The address and pairing token of the service running on your computer."
        actions={
          <Badge tone={connected ? 'green' : connection.phase === 'failed' ? 'red' : 'amber'}>{connected ? 'Connected' : connection.phase === 'needs-token' ? 'Pairing needed' : connection.phase === 'failed' ? 'Not connected' : 'Connecting…'}</Badge>
        }
      />
      <form className="space-y-4 p-5" onSubmit={(e) => void submit(e)} aria-label="Connection settings">
        <Field label="Service address" htmlFor={`${uid}-url`} hint={<>Default: <code className="font-mono">{DEFAULT_SERVICE_URL}</code>. It must be an address on this computer.</>}>
          <input id={`${uid}-url`} type="text" inputMode="url" autoComplete="off" spellCheck={false} value={serviceUrl} onChange={(e) => setServiceUrl(e.target.value)} className={`${inputClass} font-mono`} />
        </Field>
        {!isLoopbackUrl(serviceUrl.includes('://') ? serviceUrl : `http://${serviceUrl}`) && !isPageOrigin(serviceUrl.includes('://') ? serviceUrl : `http://${serviceUrl}`) ? (
          <p role="alert" className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            This address is not on your computer. The service only listens on <code className="font-mono">127.0.0.1</code>, so a different address will not work.
          </p>
        ) : null}
        <Field label="Pairing token" htmlFor={`${uid}-token`} error={error ?? undefined} hint={manager.client.hasToken ? 'A token is saved. Paste a new one only to replace it.' : 'Printed in the service window when it starts.'}>
          <input id={`${uid}-token`} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder={manager.client.hasToken ? '••••••••••••••••' : 'Paste the token here'} className={`${inputClass} font-mono`} />
        </Field>
        <Toggle id={`${uid}-remember`} checked={remember} onChange={setRemember} label="Remember the token on this device" description="Stored in this browser's local storage. Leave off on shared computers; the token is then forgotten when the tab closes." />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={saving} icon={<ShieldCheck className="size-4" aria-hidden />}>
            Save and connect
          </Button>
          <Button icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void manager.connect()}>
            Test connection
          </Button>
          <Button icon={<Unplug className="size-4" aria-hidden />} onClick={() => setConfirmForget(true)} disabled={!manager.client.hasToken}>
            Forget token
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirmForget}
        title="Forget the pairing token?"
        message="This page will disconnect from the service. You can pair again by entering the token."
        confirmLabel="Forget token"
        onConfirm={() => {
          manager.forgetToken();
          setConfirmForget(false);
        }}
        onCancel={() => setConfirmForget(false)}
      />
    </Card>
  );
}

function ServiceInfoCard() {
  const { connection } = useApp();
  const info = connection.info;
  if (connection.phase !== 'connected' || !info) return null;
  const rows: Array<[string, string]> = [
    ['Service version', `${info.version} (API ${info.apiVersion})`],
    ['Microsoft Edge', info.edge.found ? `${info.edge.version ?? 'installed'} — ${info.edge.executablePath ?? ''}` : 'NOT FOUND'],
    ['Node.js', info.nodeVersion],
    ['Screenshots folder', info.screenshotsDir],
    ['Browser profiles folder', info.profilesDir],
    ['Allowed websites', [...info.allowedOrigins, ...(info.allowLocalhostOrigins ? ['pages on localhost'] : [])].join(', ') || 'none'],
    ['Local addresses can be captured', info.privateTargetsAllowed ? 'Yes (ALLOW_PRIVATE_TARGETS)' : 'No (blocked for safety)'],
    ['Thumbnails', info.thumbnailsAvailable ? 'Available' : 'Unavailable — full images are used instead'],
    ['Tallest full-page capture', `${info.maxFullPageHeight.toLocaleString('en-US')} px`],
  ];
  return (
    <Card>
      <CardHeader title="Service details" description="Read from the running service." />
      <dl className="divide-y divide-slate-200 dark:divide-slate-800">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 px-5 py-2.5 text-sm sm:grid-cols-[14rem_1fr]">
            <dt className="text-slate-600 dark:text-slate-400">{label}</dt>
            <dd className="break-all font-medium text-slate-900 dark:text-slate-100">{value}</dd>
          </div>
        ))}
      </dl>
      {!info.edge.found ? <p className="border-t border-slate-200 px-5 py-3 text-sm text-red-700 dark:border-slate-800 dark:text-red-400">{info.edge.hint}</p> : null}
    </Card>
  );
}

function ProfilesCard() {
  const { connection, manager, notify, reportError } = useApp();
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = connection.phase === 'connected';

  const load = useCallback(async () => {
    try {
      setProfiles((await manager.client.profiles()).profiles);
    } catch (error) {
      reportError(error);
    }
  }, [manager, reportError]);

  useEffect(() => {
    if (connected) void load();
    else setProfiles(null);
  }, [connected, load]);

  if (!connected) return null;
  return (
    <Card>
      <CardHeader title="Saved browser profiles" description="Sign-ins kept between runs. They stay on your computer and are never sent anywhere." />
      {profiles === null ? (
        <p className="p-5 text-sm text-slate-600">Loading…</p>
      ) : profiles.length === 0 ? (
        <p className="p-5 text-sm text-slate-600 dark:text-slate-400">No saved profiles. Turn on “Use a saved browser profile” on the Dashboard to create one.</p>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {profiles.map((profile) => (
            <li key={profile.name} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <FolderOpen className="size-4 shrink-0 text-slate-500" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-900 dark:text-slate-100">{profile.name}</p>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  {formatBytes(profile.bytes)}
                  {profile.modifiedAt ? ` · last used ${formatDateTime(profile.modifiedAt, true)}` : ''}
                </p>
              </div>
              <Button size="sm" variant="danger" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setTarget(profile.name)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={target !== null}
        busy={busy}
        title="Delete this browser profile?"
        message={<p>Everything saved in the profile <strong>{target}</strong> (cookies, sign-ins) is deleted from your computer. You will have to sign in again.</p>}
        confirmLabel="Delete profile"
        onCancel={() => setTarget(null)}
        onConfirm={() => {
          if (!target) return;
          setBusy(true);
          manager.client.deleteProfile(target).then(
            () => {
              notify('success', `Profile "${target}" deleted.`);
              setTarget(null);
              setBusy(false);
              void load();
            },
            (error: unknown) => {
              reportError(error);
              setBusy(false);
            },
          );
        }}
      />
    </Card>
  );
}

function AppearanceCard() {
  const { choice, setChoice } = useTheme();
  const options: Array<{ value: ThemeChoice; label: string; icon: typeof Sun }> = [
    { value: 'system', label: 'Match system', icon: Monitor },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
  ];
  return (
    <Card>
      <CardHeader title="Appearance" />
      <div className="p-5">
        <div role="radiogroup" aria-label="Theme" className="inline-flex flex-wrap gap-2">
          {options.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={choice === value}
              onClick={() => setChoice(value)}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-inset ${choice === value ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-800 ring-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600'}`}
            >
              <Icon className="size-4" aria-hidden />
              {label}
              {choice === value ? <CircleCheck className="size-4" aria-hidden /> : null}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

function PrivacyCard() {
  // Served together with its service (GitHub Codespaces): the service is not on this computer, so the usual promises would be false.
  if (pageServesService()) {
    return (
      <Card>
        <CardHeader title="How your data is handled" />
        <ul className="list-disc space-y-1.5 p-5 pl-9 text-sm text-slate-700 dark:text-slate-300" data-testid="privacy-hosted">
          <li>This page and its service run together on a remote machine (a GitHub Codespace), not on this computer. Screenshots, their list and browser profiles are stored in that machine&apos;s folders. There is no separate cloud storage or database.</li>
          <li>The remote machine, and everything on it, belongs to your GitHub account. It is kept while the Codespace exists and is deleted with it, so download what you want to keep.</li>
          <li>The address of this page is private to your GitHub account. Making the forwarded port public would let anyone with the link reach it; the pairing token is still required, but do not share the link.</li>
          <li>This browser keeps only a few preferences (the form values and, if you allow it, the pairing token). It never stores screenshots.</li>
          <li>Sign-in cookies for saved profiles stay in the profile folder on the remote machine.</li>
        </ul>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="How your data is handled" />
      <ul className="list-disc space-y-1.5 p-5 pl-9 text-sm text-slate-700 dark:text-slate-300">
        <li>Screenshots, their list and browser profiles are stored only in folders on this computer, by the local service. There is no cloud storage or database.</li>
        <li>This web page keeps only a few preferences in your browser (the service address, the form values and, if you allow it, the pairing token). It never stores screenshots.</li>
        <li>The page and the service talk directly on your computer. Nothing is uploaded to GitHub, to the page's host or to any other server.</li>
        <li>Sign-in cookies for saved profiles stay in the profile folder on your computer.</li>
      </ul>
    </Card>
  );
}

export function SettingsPage() {
  const { connection } = useApp();
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">Settings</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Connect this page to the screenshot service on your computer.</p>
      </header>
      <ConnectionPanel compact />
      <ConnectionCard />
      {connection.phase !== 'connected' ? (
        <Card>
          <CardHeader title="Set up the local service" description="This page cannot control your browser on its own." />
          <div className="p-5">
            <SetupSteps />
          </div>
        </Card>
      ) : null}
      <ServiceInfoCard />
      <ProfilesCard />
      <AppearanceCard />
      <PrivacyCard />
    </div>
  );
}
