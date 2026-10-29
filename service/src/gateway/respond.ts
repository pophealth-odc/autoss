import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { ApiErrorBody, ErrorCode } from '../shared/contract.js';

/** An error in the same `{ error: { code, message } }` shape the service uses, so the web page can read it. */
export function sendError(res: ServerResponse, status: number, code: ErrorCode, message: string, headers: OutgoingHttpHeaders = {}): void {
  if (res.destroyed) return;
  const body: ApiErrorBody = { error: { code, message } };
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

export function sendText(res: ServerResponse, status: number, text: string, headers: OutgoingHttpHeaders = {}): void {
  if (res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}
