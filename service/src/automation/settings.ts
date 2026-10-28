import { z } from 'zod';
import { LIMITS, type AutomationSettings } from '../shared/contract.js';
import { parseUrlInput } from '../shared/url-input.js';
import { UnsafePathError, validateFolder } from '../storage/safe-path.js';

const intInRange = (range: { min: number; max: number; default: number }, label: string) =>
  z
    .number({ error: `${label} must be a number.` })
    .int(`${label} must be a whole number.`)
    .min(range.min, `${label} must be at least ${range.min}.`)
    .max(range.max, `${label} must be at most ${range.max}.`)
    .optional();

export const startRequestSchema = z.strictObject({
  urls: z
    .array(z.string().max(LIMITS.maxUrlLength * 2))
    .min(1, 'Add at least one web address.')
    .max(LIMITS.maxUrls, `At most ${LIMITS.maxUrls} web addresses can be processed in one run.`),
  browser: z.literal('msedge').optional(),
  mode: z.enum(['headed', 'headless']).optional(),
  screenshotMode: z.enum(['fullPage', 'viewport']).optional(),
  followLinks: z.boolean().optional(),
  maxPages: z
    .number()
    .int()
    .min(1, 'The maximum number of pages must be at least 1.')
    .max(LIMITS.maxPagesCap, `The maximum number of pages must be at most ${LIMITS.maxPagesCap}.`)
    .optional(),
  sameOrigin: z.boolean().optional(),
  pageTimeoutMs: intInRange(LIMITS.pageTimeoutMs, 'The page load timeout'),
  extraWaitMs: intInRange(LIMITS.extraWaitMs, 'The extra wait time'),
  delayBetweenPagesMs: intInRange(LIMITS.delayBetweenPagesMs, 'The delay between pages'),
  viewportWidth: intInRange(LIMITS.viewportWidth, 'The viewport width'),
  viewportHeight: intInRange(LIMITS.viewportHeight, 'The viewport height'),
  pageScalePercent: intInRange(LIMITS.pageScalePercent, 'The page scale'),
  autoScroll: z.boolean().optional(),
  ignoreCertificateErrors: z.boolean().optional(),
  outputFolder: z.string().max(LIMITS.folderMaxLength * 2).optional(),
  persistentProfile: z.boolean().optional(),
  profileName: z.string().max(LIMITS.profileNameMax * 2).optional(),
  manualLogin: z.boolean().optional(),
});

export interface SettingsIssue {
  field: string;
  message: string;
}

export type SettingsResult = { ok: true; settings: AutomationSettings } | { ok: false; issues: SettingsIssue[] };

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalises the address list and reports each unusable line. Entries that are not strings are left to the schema. */
function checkUrls(raw: unknown, issues: SettingsIssue[]): string[] {
  const urls: string[] = [];
  if (!Array.isArray(raw)) return urls;
  const seen = new Set<string>();
  raw.slice(0, LIMITS.maxUrls).forEach((entry: unknown, index) => {
    if (typeof entry !== 'string') return;
    const result = parseUrlInput(entry, LIMITS.maxUrlLength);
    if (!result.ok) {
      issues.push({ field: `urls.${index}`, message: `"${entry.slice(0, 80)}": ${result.error}` });
    } else if (!seen.has(result.url)) {
      seen.add(result.url);
      urls.push(result.url);
    }
  });
  return urls;
}

function checkFolder(raw: unknown, issues: SettingsIssue[]): string {
  if (typeof raw !== 'string') return '';
  try {
    return validateFolder(raw);
  } catch (error) {
    if (!(error instanceof UnsafePathError)) throw error;
    issues.push({ field: 'outputFolder', message: error.message });
    return '';
  }
}

/**
 * Validates a start request and applies defaults. Every problem is collected, so the UI can show them all at once
 * instead of making the person fix one field per attempt.
 */
export function resolveSettings(body: unknown): SettingsResult {
  const issues: SettingsIssue[] = [];
  const parsed = startRequestSchema.safeParse(body);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ field: issue.path.join('.') || 'request', message: issue.message });
    }
  }

  const raw = isRecord(body) ? body : {};
  const urls = checkUrls(raw['urls'], issues);
  const outputFolder = checkFolder(raw['outputFolder'], issues);

  const mode = raw['mode'] === 'headed' ? 'headed' : 'headless';
  if (raw['manualLogin'] === true && mode !== 'headed') {
    issues.push({ field: 'manualLogin', message: 'Manual login needs the visible (headed) browser window.' });
  }

  const persistentProfile = raw['persistentProfile'] === true;
  const rawProfile = typeof raw['profileName'] === 'string' ? raw['profileName'].trim() : '';
  const profileName = rawProfile === '' ? 'default' : rawProfile;
  if (persistentProfile && !PROFILE_NAME.test(profileName)) {
    issues.push({
      field: 'profileName',
      message: `The profile name must start with a letter or digit and contain at most ${LIMITS.profileNameMax} letters, digits, spaces, "_" or "-".`,
    });
  }

  if (!parsed.success || issues.length > 0) {
    const unique = issues.filter((issue, i) => issues.findIndex((o) => o.field === issue.field && o.message === issue.message) === i);
    return { ok: false, issues: unique };
  }

  const input = parsed.data;
  const settings: AutomationSettings = {
    browser: 'msedge',
    mode,
    screenshotMode: input.screenshotMode ?? 'fullPage',
    urls,
    followLinks: input.followLinks ?? false,
    maxPages: input.maxPages ?? LIMITS.defaultMaxPages,
    sameOrigin: input.sameOrigin ?? true,
    pageTimeoutMs: input.pageTimeoutMs ?? LIMITS.pageTimeoutMs.default,
    extraWaitMs: input.extraWaitMs ?? LIMITS.extraWaitMs.default,
    delayBetweenPagesMs: input.delayBetweenPagesMs ?? LIMITS.delayBetweenPagesMs.default,
    viewportWidth: input.viewportWidth ?? LIMITS.viewportWidth.default,
    viewportHeight: input.viewportHeight ?? LIMITS.viewportHeight.default,
    pageScalePercent: input.pageScalePercent ?? LIMITS.pageScalePercent.default,
    autoScroll: input.autoScroll ?? true,
    ignoreCertificateErrors: input.ignoreCertificateErrors ?? false,
    outputFolder,
    persistentProfile,
    profileName,
    manualLogin: input.manualLogin ?? false,
  };
  return { ok: true, settings };
}
