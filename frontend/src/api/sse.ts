/**
 * Incremental parser for the text/event-stream format. Feed it decoded text in any chunking; it returns the events that
 * became complete. Handles "\n", "\r\n" and "\r" line endings, comment lines, multi-line data and ids.
 */
export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
  retry: number | null;
}

export class SseParser {
  private buffer = '';
  private id: string | null = null;
  private event = '';
  private data: string[] = [];
  private retry: number | null = null;
  /** True when the previous chunk ended in "\r", so a leading "\n" in the next chunk belongs to the same line break. */
  private pendingCr = false;
  /** Last event id seen, kept across messages as the specification requires. */
  lastEventId: string | null = null;

  push(chunk: string): SseMessage[] {
    let text = chunk;
    if (this.pendingCr && text.startsWith('\n')) text = text.slice(1);
    this.pendingCr = text.endsWith('\r');
    this.buffer += text;

    const messages: SseMessage[] = [];
    // Split on any line ending, keeping an incomplete last line in the buffer.
    const lines = this.buffer.split(/\r\n|\n|\r/);
    this.buffer = lines.pop() ?? '';
    // A buffered line that ended with "\r" is complete; split() would have kept it as the tail only if no terminator followed.
    if (this.pendingCr && this.buffer === '') {
      /* the trailing "\r" already terminated the previous line */
    }
    for (const line of lines) {
      const message = this.line(line);
      if (message) messages.push(message);
    }
    return messages;
  }

  private line(line: string): SseMessage | null {
    if (line === '') {
      // Blank line: dispatch the event if it has data.
      if (this.data.length === 0) {
        this.event = '';
        this.retry = null;
        return null;
      }
      const message: SseMessage = {
        id: this.id,
        event: this.event === '' ? 'message' : this.event,
        data: this.data.join('\n'),
        retry: this.retry,
      };
      this.id = null;
      this.event = '';
      this.data = [];
      this.retry = null;
      return message;
    }
    if (line.startsWith(':')) return null; // comment / keep-alive

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        this.event = value;
        break;
      case 'data':
        this.data.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) {
          this.id = value;
          this.lastEventId = value;
        }
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break;
    }
    return null;
  }
}

export interface ReadStreamOptions {
  onMessage: (message: SseMessage) => void;
  signal: AbortSignal;
}

/** Reads a streaming Response body to its end (or until aborted), decoding UTF-8 correctly across chunk boundaries. */
export async function readEventStream(body: ReadableStream<Uint8Array>, parser: SseParser, options: ReadStreamOptions): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const message of parser.push(decoder.decode(value, { stream: true }))) options.onMessage(message);
    }
    for (const message of parser.push(decoder.decode())) options.onMessage(message);
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** Reconnect delay: exponential with jitter, never below the server's suggestion and never above 30 s. */
export function reconnectDelay(attempt: number, serverRetryMs: number | null, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  const jittered = base * (0.7 + random() * 0.6);
  return Math.round(Math.max(serverRetryMs ?? 0, jittered));
}
