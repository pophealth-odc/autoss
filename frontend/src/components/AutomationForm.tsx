import { CalendarDays, Eraser, FolderOpen, Globe, Info, ListPlus, Lock } from 'lucide-react';
import { useId } from 'react';
import { LIMITS } from '../api/contract';
import { expandUrlPlaceholders, hasUrlPlaceholder, previousDay } from '../api/url-input';
import type { FormIssue, FormState } from '../lib/form';
import { Button, Card, CardHeader, Field, inputClass, Toggle } from './ui';

/** The page scales people reach for most; any whole number from 25 to 500 can also be typed. */
const SCALE_PRESETS = [25, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 300, 400, 500] as const;

interface Props {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  issues: FormIssue[];
  disabled: boolean;
  urlCount: number;
  onClearUrls: () => void;
  outputRoot: string | null;
}

function issueFor(issues: FormIssue[], field: FormIssue['field']): string | undefined {
  const matches = issues.filter((i) => i.field === field);
  return matches.length > 0 ? matches.map((i) => i.message).join(' ') : undefined;
}

function NumberInput({ id, value, min, max, step = 1, onChange, disabled, suffix, invalid, describedBy }: { id: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void; disabled: boolean; suffix?: string; invalid: boolean; describedBy?: string | undefined }) {
  return (
    <div className="relative">
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ''}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
        className={`${inputClass} ${suffix ? 'pr-12' : ''}`}
      />
      {suffix ? <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-500">{suffix}</span> : null}
    </div>
  );
}

export function AutomationForm({ form, onChange, issues, disabled, urlCount, onClearUrls, outputRoot }: Props) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const urlsError = issueFor(issues, 'urls');
  const scaleError = issueFor(issues, 'pageScalePercent');
  const usesPlaceholder = hasUrlPlaceholder(`${form.initialUrl}\n${form.urlText}`);
  // What each placeholder address will be on the day the run starts, so a wrong date is seen before Start, not after.
  const placeholderLines = usesPlaceholder
    ? `${form.initialUrl}\n${form.urlText}`
        .split(/\r\n|\r|\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#') && hasUrlPlaceholder(line))
    : [];
  const scaleHint =
    form.mode === 'headless'
      ? 'Like the browser’s zoom: 50 shows twice as much of the page, 200 shows less, larger. Screenshots match exactly.'
      : form.pageScalePercent > 100
        ? 'Like the browser’s zoom. Above 100 a visible window’s screenshot comes out smaller than the page; use Headless for exact images.'
        : 'Like the browser’s zoom: 50 shows twice as much of the page, 200 shows less, larger.';

  return (
    <Card>
      <CardHeader title="Automation settings" description="Choose what to capture and how. Settings are remembered in this browser." />
      <form
        className="space-y-6 p-5"
        onSubmit={(e) => e.preventDefault()}
        aria-label="Automation settings"
      >
        <fieldset disabled={disabled} className="space-y-6 disabled:opacity-70">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Browser" htmlFor={id('browser')} hint="Only Microsoft Edge (stable) is supported.">
              <select id={id('browser')} value={form.browser} onChange={() => onChange({ browser: 'msedge' })} className={inputClass}>
                <option value="msedge">Microsoft Edge</option>
              </select>
            </Field>
            <Field label="Browser mode" htmlFor={id('mode')} hint={form.mode === 'headed' ? 'Edge opens a maximized window while it works.' : 'Edge runs in the background without a window.'}>
              <select id={id('mode')} value={form.mode} onChange={(e) => onChange({ mode: e.target.value === 'headed' ? 'headed' : 'headless', ...(e.target.value !== 'headed' ? { manualLogin: false } : {}) })} className={inputClass}>
                <option value="headless">Headless (background)</option>
                <option value="headed">Headed (show the Edge window)</option>
              </select>
            </Field>
            <Field label="Screenshot mode" htmlFor={id('shot')} hint={form.screenshotMode === 'fullPage' ? 'Captures the whole page from top to bottom.' : 'Captures only what is visible in the browser window.'}>
              <select id={id('shot')} value={form.screenshotMode} onChange={(e) => onChange({ screenshotMode: e.target.value === 'viewport' ? 'viewport' : 'fullPage' })} className={inputClass}>
                <option value="fullPage">Full page</option>
                <option value="viewport">Visible viewport</option>
              </select>
            </Field>
            <Field label="Page scale" htmlFor={id('scale')} error={scaleError} hint={scaleHint}>
              <div className="relative">
                <input
                  id={id('scale')}
                  type="number"
                  inputMode="numeric"
                  list={id('scale-presets')}
                  min={LIMITS.pageScalePercent.min}
                  max={LIMITS.pageScalePercent.max}
                  step={1}
                  value={Number.isFinite(form.pageScalePercent) ? form.pageScalePercent : ''}
                  aria-invalid={scaleError ? true : undefined}
                  onChange={(e) => onChange({ pageScalePercent: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
                  className={`${inputClass} pr-9`}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-500">%</span>
                <datalist id={id('scale-presets')}>
                  {SCALE_PRESETS.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </div>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Initial URL" htmlFor={id('initial')} hint="Optional. The first page to capture.">
                <div className="relative">
                  <Globe className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden />
                  <input
                    id={id('initial')}
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://example.com"
                    value={form.initialUrl}
                    onChange={(e) => onChange({ initialUrl: e.target.value })}
                    className={`${inputClass} pl-9`}
                  />
                </div>
              </Field>
            </div>
          </div>

          <Field
            label="Web addresses (one per line)"
            htmlFor={id('urls')}
            error={urlsError}
            hint={
              <>
                Lines starting with # are ignored. Up to {LIMITS.maxUrls} addresses; duplicates are removed. Write <code className="font-mono">{'{$prevday}'}</code> anywhere in
                an address to use yesterday&rsquo;s date as <code className="font-mono">yyyy-MM-dd</code>.
              </>
            }
          >
            <textarea
              id={id('urls')}
              rows={6}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={urlsError ? true : undefined}
              placeholder={'https://example.com\nhttps://example.org/about'}
              value={form.urlText}
              onChange={(e) => onChange({ urlText: e.target.value })}
              className={`${inputClass} font-mono`}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
                <ListPlus className="size-4" aria-hidden />
                {urlCount === 0 ? 'No addresses yet' : `${urlCount.toLocaleString('en-US')} ${urlCount === 1 ? 'address' : 'addresses'} ready`}
              </span>
            </div>
            {placeholderLines.length > 0 ? (
              <div className="mt-2 rounded-lg bg-sky-50 p-3 text-xs text-sky-950 dark:bg-sky-950/40 dark:text-sky-100" data-testid="prevday-preview">
                <p className="flex items-center gap-1.5 font-medium">
                  <CalendarDays className="size-4 shrink-0" aria-hidden />
                  <span>
                    <code className="font-mono">{'{$prevday}'}</code> becomes <strong>{previousDay()}</strong> (yesterday) when you press Start
                  </span>
                </p>
                <ul className="mt-1.5 space-y-1">
                  {placeholderLines.slice(0, 4).map((line, index) => (
                    <li key={index} className="font-mono [overflow-wrap:anywhere]">
                      {/* A break opportunity after every ? and & keeps each query parameter in one piece where it can. */}
                      {expandUrlPlaceholders(line)
                        .split(/(?=[?&])/)
                        .map((part, i) => (
                          <span key={i} className="inline-block max-w-full">
                            {part}
                          </span>
                        ))}
                    </li>
                  ))}
                </ul>
                {placeholderLines.length > 4 ? <p className="mt-1">…and {placeholderLines.length - 4} more.</p> : null}
              </div>
            ) : null}
          </Field>

          <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <Toggle id={id('follow')} checked={form.followLinks} onChange={(followLinks) => onChange({ followLinks })} label="Follow links between pages" description="After capturing a page, also visit the links found on it, up to the limit below." />
            <div className="grid gap-4 pl-7 sm:grid-cols-2">
              <Field label="Maximum number of pages" htmlFor={id('max')} error={issueFor(issues, 'maxPages')} hint="Total pages captured, including the addresses above.">
                <NumberInput id={id('max')} value={form.maxPages} min={1} max={LIMITS.maxPagesCap} onChange={(maxPages) => onChange({ maxPages })} disabled={disabled || !form.followLinks} invalid={!!issueFor(issues, 'maxPages')} />
              </Field>
              <div className="self-end pb-1">
                <Toggle id={id('same')} checked={form.sameOrigin} onChange={(sameOrigin) => onChange({ sameOrigin })} label="Stay on the same site" description="Only follow links to the same origin (scheme, host and port)." disabled={disabled || !form.followLinks} />
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Page load timeout" htmlFor={id('timeout')} error={issueFor(issues, 'pageTimeoutSec')} hint="Give up on a page after this long.">
              <NumberInput id={id('timeout')} value={form.pageTimeoutSec} min={LIMITS.pageTimeoutMs.min / 1000} max={LIMITS.pageTimeoutMs.max / 1000} onChange={(pageTimeoutSec) => onChange({ pageTimeoutSec })} disabled={disabled} suffix="sec" invalid={!!issueFor(issues, 'pageTimeoutSec')} />
            </Field>
            <Field label="Extra wait after loading" htmlFor={id('wait')} error={issueFor(issues, 'extraWaitSec')} hint="For pages that keep drawing after they load.">
              <NumberInput id={id('wait')} value={form.extraWaitSec} min={0} max={LIMITS.extraWaitMs.max / 1000} step={0.5} onChange={(extraWaitSec) => onChange({ extraWaitSec })} disabled={disabled} suffix="sec" invalid={!!issueFor(issues, 'extraWaitSec')} />
            </Field>
            <Field label="Delay between pages" htmlFor={id('delay')} error={issueFor(issues, 'delayBetweenPagesSec')} hint="A pause before the next page.">
              <NumberInput id={id('delay')} value={form.delayBetweenPagesSec} min={0} max={LIMITS.delayBetweenPagesMs.max / 1000} step={0.5} onChange={(delayBetweenPagesSec) => onChange({ delayBetweenPagesSec })} disabled={disabled} suffix="sec" invalid={!!issueFor(issues, 'delayBetweenPagesSec')} />
            </Field>
          </div>

          <Field
            label="Output folder"
            htmlFor={id('folder')}
            error={issueFor(issues, 'outputFolder')}
            hint={
              <>
                A sub-folder of the screenshots folder{outputRoot ? <> (<code className="font-mono">{outputRoot}</code>)</> : ''}. Leave empty to save directly in it. Letters, digits, spaces and . _ - ( ) only; no absolute paths.
              </>
            }
          >
            <div className="relative">
              <FolderOpen className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden />
              <input id={id('folder')} type="text" autoComplete="off" spellCheck={false} placeholder="for example: client-a\home-pages" value={form.outputFolder} onChange={(e) => onChange({ outputFolder: e.target.value })} className={`${inputClass} pl-9`} />
            </div>
          </Field>

          <details className="rounded-lg border border-slate-200 p-4 dark:border-slate-700" open={form.persistentProfile || form.manualLogin || form.ignoreCertificateErrors}>
            <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
              <Lock className="size-4" aria-hidden />
              Sign-in and advanced options
            </summary>
            <div className="mt-4 space-y-4">
              <p className="flex gap-2 rounded-lg bg-sky-50 p-3 text-xs text-sky-900 dark:bg-sky-950/50 dark:text-sky-100">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  Pages that need a sign-in work best in <strong>Headed</strong> mode: sign in once in the Edge window and keep the session in a saved profile. Single sign-on, multi-factor prompts and CAPTCHAs often cannot be completed in headless mode. Profile data stays on your computer.
                </span>
              </p>
              <Toggle id={id('profile')} checked={form.persistentProfile} onChange={(persistentProfile) => onChange({ persistentProfile })} label="Use a saved browser profile" description="Keeps cookies and sign-ins between runs. This is a separate profile, not your everyday Edge profile." />
              <Field label="Profile name" htmlFor={id('pname')} error={issueFor(issues, 'profileName')}>
                <input id={id('pname')} type="text" autoComplete="off" value={form.profileName} disabled={disabled || !form.persistentProfile} onChange={(e) => onChange({ profileName: e.target.value })} className={inputClass} />
              </Field>
              <Toggle id={id('login')} checked={form.manualLogin} onChange={(manualLogin) => onChange({ manualLogin })} label="Pause so I can sign in first" description={issueFor(issues, 'manualLogin') ?? 'Opens the first page and waits until you press Continue. Needs Headed mode.'} disabled={disabled || form.mode !== 'headed'} />
              <Toggle id={id('scroll')} checked={form.autoScroll} onChange={(autoScroll) => onChange({ autoScroll })} label="Scroll the page before a full-page capture" description="Loads images that only appear when scrolled into view." />
              <Toggle id={id('cert')} checked={form.ignoreCertificateErrors} onChange={(ignoreCertificateErrors) => onChange({ ignoreCertificateErrors })} label="Ignore certificate errors" description="Captures sites with an invalid or self-signed certificate. Only for sites you trust." />
            </div>
          </details>
        </fieldset>

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" icon={<Eraser className="size-4" aria-hidden />} onClick={onClearUrls} disabled={disabled || (form.urlText === '' && form.initialUrl === '')}>
            Clear URL list
          </Button>
        </div>
      </form>
    </Card>
  );
}
