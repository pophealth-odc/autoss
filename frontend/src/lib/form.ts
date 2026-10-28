import { LIMITS, type StartAutomationRequest } from '../api/contract';
import { parseUrlList, type UrlListParseResult } from '../api/url-input';

/** Everything the "Automation settings" form edits. Numbers are kept as numbers; the inputs convert on change. */
export interface FormState {
  browser: 'msedge';
  mode: 'headed' | 'headless';
  screenshotMode: 'fullPage' | 'viewport';
  /** The "initial URL" field. */
  initialUrl: string;
  /** The multiline field, one address per line. */
  urlText: string;
  followLinks: boolean;
  maxPages: number;
  sameOrigin: boolean;
  pageTimeoutSec: number;
  extraWaitSec: number;
  delayBetweenPagesSec: number;
  /** Page scale in percent (the browser's zoom), used when the browser opens - headless and headed. */
  pageScalePercent: number;
  autoScroll: boolean;
  ignoreCertificateErrors: boolean;
  outputFolder: string;
  persistentProfile: boolean;
  profileName: string;
  manualLogin: boolean;
}

/**
 * The addresses a new form starts with. {$prevday} stands for yesterday's date (yyyy-MM-dd) and is filled in when the list is
 * read, so these stay correct from day to day.
 */
export const DEFAULT_URL_TEXT = [
  'https://aaj23525.live.dynatrace.com/ui/problems?gtf={$prevday}T00:00:00%2B08:00%20to%20{$prevday}T23:59:00%2B08:00&gf=3826532857493469977',
  'https://aaj23525.live.dynatrace.com/ui/problems?gtf={$prevday}T00:00:00%2B08:00%20to%20{$prevday}T23:59:00%2B08:00&gf=3826532857493469977&status=CLOSED',
].join('\n');

export const DEFAULT_FORM: FormState = {
  browser: 'msedge',
  mode: 'headless',
  screenshotMode: 'fullPage',
  initialUrl: '',
  urlText: DEFAULT_URL_TEXT,
  followLinks: false,
  maxPages: LIMITS.defaultMaxPages,
  sameOrigin: true,
  pageTimeoutSec: LIMITS.pageTimeoutMs.default / 1000,
  extraWaitSec: LIMITS.extraWaitMs.default / 1000,
  delayBetweenPagesSec: LIMITS.delayBetweenPagesMs.default / 1000,
  pageScalePercent: LIMITS.pageScalePercent.default,
  autoScroll: true,
  ignoreCertificateErrors: false,
  outputFolder: '',
  persistentProfile: false,
  profileName: 'default',
  manualLogin: false,
};

export function isFormState(value: unknown): value is FormState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['browser'] === 'msedge' &&
    (v['mode'] === 'headed' || v['mode'] === 'headless') &&
    (v['screenshotMode'] === 'fullPage' || v['screenshotMode'] === 'viewport') &&
    typeof v['initialUrl'] === 'string' &&
    typeof v['urlText'] === 'string' &&
    typeof v['followLinks'] === 'boolean' &&
    typeof v['maxPages'] === 'number' &&
    typeof v['sameOrigin'] === 'boolean' &&
    typeof v['pageTimeoutSec'] === 'number' &&
    typeof v['extraWaitSec'] === 'number' &&
    typeof v['delayBetweenPagesSec'] === 'number' &&
    // A form saved before page scale existed has no such field; it is filled in with the default by mergeForm().
    (v['pageScalePercent'] === undefined || typeof v['pageScalePercent'] === 'number') &&
    typeof v['autoScroll'] === 'boolean' &&
    typeof v['ignoreCertificateErrors'] === 'boolean' &&
    typeof v['outputFolder'] === 'string' &&
    typeof v['persistentProfile'] === 'boolean' &&
    typeof v['profileName'] === 'string' &&
    typeof v['manualLogin'] === 'boolean'
  );
}

/**
 * Version of the saved form. Version 2 introduced the default addresses; a form saved before then (it has no version) has an
 * address list that simply never had a chance to hold them, so it gets them once. From then on the list is whatever the person
 * left it as, including empty.
 */
export const FORM_VERSION = 2;

export interface SavedForm extends Partial<FormState> {
  formVersion?: number;
}

/** Merges saved values over the defaults so a form saved by an older version still loads. */
export function mergeForm(saved: SavedForm | null): FormState {
  if (saved === null) return { ...DEFAULT_FORM };
  const { formVersion, ...rest } = saved;
  const merged: FormState = { ...DEFAULT_FORM, ...rest };
  // A form from before the defaults existed: its empty address list is "never filled in", not "cleared on purpose".
  if ((formVersion ?? 1) < 2 && merged.urlText.trim() === '' && merged.initialUrl.trim() === '') merged.urlText = DEFAULT_URL_TEXT;
  return merged;
}

/** What is written to the browser's storage. */
export function toSavedForm(form: FormState): SavedForm {
  return { ...form, formVersion: FORM_VERSION };
}

export interface FormIssue {
  field: keyof FormState | 'urls';
  message: string;
}

export interface BuiltRequest {
  request: StartAutomationRequest | null;
  issues: FormIssue[];
  /** Every distinct address that will be sent. */
  urls: string[];
  parse: UrlListParseResult;
}

function checkRange(value: number, min: number, max: number, scale: number, label: string, field: keyof FormState, issues: FormIssue[]): number {
  if (!Number.isFinite(value)) {
    issues.push({ field, message: `${label} must be a number.` });
    return min;
  }
  const ms = Math.round(value * scale);
  if (ms < min || ms > max) {
    issues.push({ field, message: `${label} must be between ${min / scale} and ${max / scale}${scale === 1000 ? ' seconds' : ''}.` });
  }
  return ms;
}

/**
 * Turns the form into a request for the service and lists every problem found, so the person can fix them in one go.
 * `now` decides what {$prevday} means; it is the moment the list is read (when Start is pressed), not when it was typed.
 */
export function buildRequest(form: FormState, now: Date = new Date()): BuiltRequest {
  const issues: FormIssue[] = [];
  const combined = [form.initialUrl.trim(), form.urlText].filter((t) => t.trim() !== '').join('\n');
  const parse = parseUrlList(combined, LIMITS.maxUrlLength, now);

  if (parse.urls.length === 0 && parse.errors.length === 0) {
    issues.push({ field: 'urls', message: 'Add at least one web address.' });
  }
  for (const error of parse.errors.slice(0, 5)) {
    issues.push({ field: 'urls', message: `Line ${error.line}: "${error.text.slice(0, 60)}" - ${error.error}` });
  }
  if (parse.errors.length > 5) issues.push({ field: 'urls', message: `…and ${parse.errors.length - 5} more addresses with problems.` });
  if (parse.urls.length > LIMITS.maxUrls) {
    issues.push({ field: 'urls', message: `At most ${LIMITS.maxUrls} addresses can be processed in one run (you entered ${parse.urls.length}).` });
  }

  const pageTimeoutMs = checkRange(form.pageTimeoutSec, LIMITS.pageTimeoutMs.min, LIMITS.pageTimeoutMs.max, 1000, 'The page load timeout', 'pageTimeoutSec', issues);
  const extraWaitMs = checkRange(form.extraWaitSec, LIMITS.extraWaitMs.min, LIMITS.extraWaitMs.max, 1000, 'The extra wait time', 'extraWaitSec', issues);
  const delayBetweenPagesMs = checkRange(form.delayBetweenPagesSec, LIMITS.delayBetweenPagesMs.min, LIMITS.delayBetweenPagesMs.max, 1000, 'The delay between pages', 'delayBetweenPagesSec', issues);

  const scale = LIMITS.pageScalePercent;
  if (!Number.isInteger(form.pageScalePercent) || form.pageScalePercent < scale.min || form.pageScalePercent > scale.max) {
    issues.push({ field: 'pageScalePercent', message: `The page scale must be a whole number from ${scale.min} to ${scale.max} percent.` });
  }

  if (form.followLinks && (!Number.isInteger(form.maxPages) || form.maxPages < 1 || form.maxPages > LIMITS.maxPagesCap)) {
    issues.push({ field: 'maxPages', message: `The maximum number of pages must be a whole number from 1 to ${LIMITS.maxPagesCap}.` });
  }
  if (form.persistentProfile && !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(form.profileName.trim())) {
    issues.push({ field: 'profileName', message: 'The profile name must start with a letter or digit and use only letters, digits, spaces, "_" or "-" (32 characters at most).' });
  }
  if (form.manualLogin && form.mode !== 'headed') {
    issues.push({ field: 'manualLogin', message: 'Manual sign-in needs the visible browser window. Choose "Headed" mode.' });
  }

  if (issues.length > 0) return { request: null, issues, urls: parse.urls, parse };

  const request: StartAutomationRequest = {
    urls: parse.urls,
    browser: form.browser,
    mode: form.mode,
    screenshotMode: form.screenshotMode,
    followLinks: form.followLinks,
    maxPages: form.followLinks ? form.maxPages : Math.max(1, parse.urls.length),
    sameOrigin: form.sameOrigin,
    pageTimeoutMs,
    extraWaitMs,
    delayBetweenPagesMs,
    pageScalePercent: form.pageScalePercent,
    autoScroll: form.autoScroll,
    ignoreCertificateErrors: form.ignoreCertificateErrors,
    outputFolder: form.outputFolder.trim(),
    persistentProfile: form.persistentProfile,
    profileName: form.persistentProfile ? form.profileName.trim() || 'default' : 'default',
    manualLogin: form.manualLogin,
  };
  return { request, issues, urls: parse.urls, parse };
}
