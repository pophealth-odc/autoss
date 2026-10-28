import { serviceHas, type ServiceHealth, type StartAutomationRequest } from '../api/contract';

/**
 * The page and the service are updated separately: the page hot-reloads or is redeployed, while a running service keeps the
 * code it was started with. This module decides what to do when the two disagree about an optional ability, so the person
 * gets an instruction ("restart the service") instead of a raw validation error.
 */

export const RESTART_HINT = 'Close the service window (or press Ctrl+C in it) and start it again with start-service.bat.';

export interface Adapted {
  /** The request to send; settings the service cannot understand are left out when leaving them out changes nothing. */
  request: StartAutomationRequest;
  /** Set when the run must NOT start, because dropping a setting would silently change what is captured. */
  blocked: string | null;
  /** Shown to the person when something was left out harmlessly. */
  notice: string | null;
}

/**
 * Fits a start request to what the connected service can do.
 *
 *  - A service that does not advertise `pageScale` rejects the whole request for the unknown `pageScalePercent` key. At the
 *    default 100 % the field adds nothing, so it is simply left out and the run proceeds. At any other value the run would
 *    capture at the wrong scale, so it is refused with an instruction instead.
 *  - `health` is null before the first answer; nothing is changed then, and the service's own answer decides.
 */
export function adaptRequest(request: StartAutomationRequest, health: ServiceHealth | null): Adapted {
  if (health === null || serviceHas(health, 'pageScale')) return { request, blocked: null, notice: null };

  const scale = request.pageScalePercent ?? 100;
  const { pageScalePercent: _omitted, ...withoutScale } = request;
  if (scale !== 100) {
    return {
      request: withoutScale,
      blocked: `The running service is an older version and cannot apply a page scale of ${scale}%. ${RESTART_HINT}`,
      notice: null,
    };
  }
  return { request: withoutScale, blocked: null, notice: null };
}

/** Whether an error from the service means "I do not know this setting", i.e. the service is older than this page. */
export function isUnknownSettingError(code: string, message: string): boolean {
  return code === 'validation_failed' && /unrecognized key/i.test(message);
}

/** The setting named in a message such as `Unrecognized key: "pageScalePercent"`, if there is one. */
export function unknownSettingName(message: string): string | null {
  return /unrecognized keys?:\s*"([^"]+)"/i.exec(message)?.[1] ?? null;
}

/** What to tell the person when the service refused a setting it does not know. */
export function explainUnknownSetting(message: string): string {
  const name = unknownSettingName(message);
  const what = name === 'pageScalePercent' ? 'the page scale' : name ? `the setting "${name}"` : 'one of these settings';
  return `The running service is an older version than this page and does not know ${what}. ${RESTART_HINT}`;
}
