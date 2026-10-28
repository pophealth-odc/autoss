import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceClient } from './client';
import { isPageOrigin, pageServesService, sameOriginServiceUrl } from './same-origin';

function documentWith(head: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head>${head}</head><body></body></html>`, 'text/html');
}

const MARKER = '<meta name="ssg-service" content="same-origin" />';
const page = { origin: 'https://my-space-4580.app.github.dev', protocol: 'https:' } as const;

describe('a page that is served together with its service', () => {
  it('is recognised only by the marker the gateway adds', () => {
    expect(pageServesService(documentWith(MARKER))).toBe(true);
    expect(pageServesService(documentWith(''))).toBe(false);
    expect(pageServesService(documentWith('<meta name="ssg-service" content="elsewhere" />'))).toBe(false);
    expect(pageServesService(documentWith('<meta name="other" content="same-origin" />'))).toBe(false);
    expect(pageServesService(null)).toBe(false); // no page at all
    expect(pageServesService()).toBe(false); // the real (test) page has no marker
  });

  it('uses the address it was loaded from as the service address', () => {
    expect(sameOriginServiceUrl(documentWith(MARKER), page)).toBe('https://my-space-4580.app.github.dev');
    expect(sameOriginServiceUrl(documentWith(MARKER), { origin: 'http://127.0.0.1:4580', protocol: 'http:' })).toBe('http://127.0.0.1:4580');
  });

  it('keeps the normal default everywhere else', () => {
    expect(sameOriginServiceUrl(documentWith(''), page)).toBeNull();
    expect(sameOriginServiceUrl(documentWith(MARKER), null)).toBeNull(); // marker, but no location to take an address from
    expect(sameOriginServiceUrl(null, page)).toBeNull();
    expect(sameOriginServiceUrl()).toBeNull(); // the real (test) page has no marker
  });

  it('takes the page\'s real address when none is given', () => {
    expect(sameOriginServiceUrl(documentWith(MARKER))).toBe(window.location.origin);
  });

  it('never takes an address from a page that is not on http or https', () => {
    expect(sameOriginServiceUrl(documentWith(MARKER), { origin: 'null', protocol: 'file:' })).toBeNull();
  });

  it('knows whether an address is the page\'s own', () => {
    expect(isPageOrigin('https://my-space-4580.app.github.dev', page)).toBe(true);
    expect(isPageOrigin('https://my-space-4580.app.github.dev/some/path?x=1', page)).toBe(true);
    expect(isPageOrigin('https://my-space-4581.app.github.dev', page)).toBe(false);
    expect(isPageOrigin('http://my-space-4580.app.github.dev', page)).toBe(false);
    expect(isPageOrigin('http://127.0.0.1:4577', page)).toBe(false);
    expect(isPageOrigin('not a url', page)).toBe(false);
    expect(isPageOrigin('https://my-space-4580.app.github.dev', null)).toBe(false);
    expect(isPageOrigin(window.location.origin)).toBe(true); // no location given: the real page's own
  });
});

describe('when the page sends cookies', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function credentialsFor(baseUrl: string): Promise<RequestCredentials | undefined> {
    let seen: RequestCredentials | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen = init?.credentials;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    await new ServiceClient({ baseUrl, token: 'a'.repeat(32) }).gallery().catch(() => undefined);
    return seen;
  }

  it('never to a service on another address (the usual case: GitHub Pages or localhost)', async () => {
    expect(await credentialsFor('http://127.0.0.1:4577')).toBe('omit');
    expect(await credentialsFor('https://example.com')).toBe('omit');
  });

  it('only to a service at the page\'s own address', async () => {
    expect(await credentialsFor(window.location.origin)).toBe('same-origin');
  });
});
