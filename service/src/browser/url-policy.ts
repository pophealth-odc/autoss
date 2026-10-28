import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { parseUrlInput } from '../shared/url-input.js';

export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string };

export type HostResolver = (hostname: string) => Promise<string[]>;

export interface UrlPolicyOptions {
  /** When true, localhost and private-network addresses may be captured (ALLOW_PRIVATE_TARGETS). */
  allowPrivate: boolean;
  /** Host names that are exempt from the private-network block (ALLOWED_TARGET_HOSTS). */
  allowedHosts: string[];
  resolve?: HostResolver;
}

export interface UrlPolicy {
  /** Full check, including DNS resolution of host names. Used before a page is opened and for each redirect hop. */
  check(rawUrl: string): Promise<PolicyVerdict>;
  /** Fast check without DNS: scheme, credentials and IP literals only. */
  checkSyntax(rawUrl: string): PolicyVerdict;
}

const defaultResolver: HostResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
];

function isPrivateV4(address: string): boolean {
  const value = ipv4ToNumber(address);
  if (value === null) return true; // unparsable: treat as unsafe
  return V4_BLOCKS.some(([base, bits]) => {
    const baseValue = ipv4ToNumber(base) as number;
    const size = 2 ** (32 - bits);
    return value >= baseValue && value < baseValue + size;
  });
}

/** Expands an IPv6 address into eight 16-bit groups. Returns null when it cannot be parsed. */
function expandV6(address: string): number[] | null {
  let text = address.split('%')[0] ?? address; // drop zone id
  if (text.includes('.')) {
    // Embedded IPv4 such as ::ffff:127.0.0.1
    const lastColon = text.lastIndexOf(':');
    const v4 = ipv4ToNumber(text.slice(lastColon + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
    return groups.some(Number.isNaN) ? null : groups;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

function isPrivateV6(address: string): boolean {
  const g = expandV6(address);
  if (g === null) return true;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, hi = 0, lo = 0] = g;
  const embeddedV4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && lo === 1) return true; // ::1
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return isPrivateV4(embeddedV4); // ::ffff:a.b.c.d
  if (a === 0x64 && b === 0xff9b) return isPrivateV4(embeddedV4); // 64:ff9b::/96 NAT64
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return isPrivateV4(embeddedV4); // deprecated IPv4-compatible
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2002) return isPrivateV4(`${b >> 8}.${b & 255}.${c >> 8}.${c & 255}`); // 6to4
  return false;
}

/** True for loopback, private, link-local, multicast, unspecified and otherwise non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) return isPrivateV6(address);
  return true;
}

const LOCAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp)$/i;

export function createUrlPolicy(options: UrlPolicyOptions): UrlPolicy {
  const resolve = options.resolve ?? defaultResolver;
  const exempt = new Set(options.allowedHosts.map((h) => h.toLowerCase()));

  const checkSyntax = (rawUrl: string): PolicyVerdict => {
    const parsed = parseUrlInput(rawUrl);
    if (!parsed.ok) return { allowed: false, reason: parsed.error };
    const url = new URL(parsed.url);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (options.allowPrivate || exempt.has(host)) return { allowed: true };
    if (net.isIP(host) !== 0 && isPrivateAddress(host)) {
      return { allowed: false, reason: `${host} is a local or private network address.` };
    }
    if (net.isIP(host) === 0 && LOCAL_NAME.test(host)) {
      return { allowed: false, reason: `${host} is a local network name.` };
    }
    return { allowed: true };
  };

  const check = async (rawUrl: string): Promise<PolicyVerdict> => {
    const syntax = checkSyntax(rawUrl);
    if (!syntax.allowed) return syntax;
    const url = new URL(new URL(rawUrl).href);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (options.allowPrivate || exempt.has(host) || net.isIP(host) !== 0) return { allowed: true };

    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch {
      // Not resolvable: let the browser report the real DNS error for this page.
      return { allowed: true };
    }
    const bad = addresses.find(isPrivateAddress);
    if (bad !== undefined) {
      return { allowed: false, reason: `${host} resolves to the local or private network address ${bad}.` };
    }
    return { allowed: true };
  };

  return { check, checkSyntax };
}
