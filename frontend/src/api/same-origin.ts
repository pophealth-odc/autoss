/**
 * Set by the small gateway that serves this page together with the service (GitHub Codespaces): the service is then reached at
 * the page's own address, because from a browser on another computer "127.0.0.1" is that computer, not the one running it.
 *
 * Everywhere else (GitHub Pages, `npm run dev`, a built copy opened from disk) the marker is absent and nothing changes.
 *
 * The parameters default to the real page. Pass `null` for "there is no page" (outside a browser); `undefined` means "use the default".
 */
const currentDocument = (): Document | null => (typeof document === 'undefined' ? null : document);
const currentLocation = (): Location | null => (typeof location === 'undefined' ? null : location);

export function pageServesService(doc: Document | null = currentDocument()): boolean {
  return doc?.querySelector('meta[name="ssg-service"][content="same-origin"]') != null;
}

/** The page's own address, or null when it does not serve the service (or is not on http or https). */
export function sameOriginServiceUrl(doc: Document | null = currentDocument(), loc: Pick<Location, 'origin' | 'protocol'> | null = currentLocation()): string | null {
  if (!pageServesService(doc) || !loc) return null;
  return loc.protocol === 'http:' || loc.protocol === 'https:' ? loc.origin : null;
}

/** True when `serviceUrl` is the address this page itself was loaded from. */
export function isPageOrigin(serviceUrl: string, loc: Pick<Location, 'origin'> | null = currentLocation()): boolean {
  if (!loc) return false;
  try {
    return new URL(serviceUrl).origin === loc.origin;
  } catch {
    return false;
  }
}
