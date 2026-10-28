import { describe, expect, it } from 'vitest';
import { readEventStream, reconnectDelay, SseParser } from './sse';

const collect = (parser: SseParser, ...chunks: string[]) => chunks.flatMap((c) => parser.push(c));

describe('SseParser', () => {
  it('parses a simple event', () => {
    const [m] = collect(new SseParser(), 'id: 7\nevent: capture\ndata: {"a":1}\n\n');
    expect(m).toEqual({ id: '7', event: 'capture', data: '{"a":1}', retry: null });
  });

  it('defaults the event name to "message"', () => {
    expect(collect(new SseParser(), 'data: hi\n\n')[0]?.event).toBe('message');
  });

  it('joins multi-line data with newlines', () => {
    expect(collect(new SseParser(), 'data: one\ndata: two\n\n')[0]?.data).toBe('one\ntwo');
  });

  it('handles events split at every byte boundary', () => {
    const text = 'id: 1\nevent: state\ndata: {"x":"y"}\n\nid: 2\nevent: capture\ndata: {"z":1}\n\n';
    const parser = new SseParser();
    const messages = Array.from(text).flatMap((ch) => parser.push(ch));
    expect(messages.map((m) => [m.id, m.event, m.data])).toEqual([
      ['1', 'state', '{"x":"y"}'],
      ['2', 'capture', '{"z":1}'],
    ]);
  });

  it('accepts CRLF and bare CR line endings, even when CR and LF arrive in separate chunks', () => {
    expect(collect(new SseParser(), 'data: a\r\n\r\n')[0]?.data).toBe('a');
    expect(collect(new SseParser(), 'data: b\r\r')[0]?.data).toBe('b');
    expect(collect(new SseParser(), 'data: c\r', '\n\r', '\n')[0]?.data).toBe('c');
  });

  it('ignores comments and keep-alives, and blank lines without data', () => {
    expect(collect(new SseParser(), ': keep-alive\n\n', 'retry: 3000\n\n')).toEqual([]);
  });

  it('reads the retry field and removes only one leading space', () => {
    const parser = new SseParser();
    const [m] = collect(parser, 'retry: 1500\ndata:  two spaces\n\n');
    expect(m).toMatchObject({ retry: 1500, data: ' two spaces' });
  });

  it('remembers the last event id across events', () => {
    const parser = new SseParser();
    collect(parser, 'id: 5\ndata: x\n\n', 'data: y\n\n');
    expect(parser.lastEventId).toBe('5');
  });

  it('does not dispatch an event that is still incomplete', () => {
    const parser = new SseParser();
    expect(collect(parser, 'data: partial')).toEqual([]);
    expect(collect(parser, ' more\n\n')[0]?.data).toBe('partial more');
  });
});

describe('readEventStream', () => {
  const encode = (s: string) => new TextEncoder().encode(s);

  function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        const chunk = chunks[i++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
  }

  it('decodes multi-byte characters that are split across chunks', async () => {
    const bytes = encode('data: 日本語 🙂\n\n');
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 2) chunks.push(bytes.slice(i, i + 2)); // 2-byte chunks cut characters in half
    const messages: string[] = [];
    await readEventStream(streamOf(chunks), new SseParser(), {
      signal: new AbortController().signal,
      onMessage: (m) => messages.push(m.data),
    });
    expect(messages).toEqual(['日本語 🙂']);
  });

  it('stops reading when aborted', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined); // never produces data
      },
      cancel() {
        /* released */
      },
    });
    const done = readEventStream(stream, new SseParser(), { signal: controller.signal, onMessage: () => undefined });
    controller.abort();
    await expect(done).resolves.toBeUndefined();
  });
});

describe('reconnectDelay', () => {
  it('grows exponentially, is capped, and honours the server hint', () => {
    const mid = () => 0.5;
    expect(reconnectDelay(0, null, mid)).toBe(1000);
    expect(reconnectDelay(1, null, mid)).toBe(2000);
    expect(reconnectDelay(3, null, mid)).toBe(8000);
    expect(reconnectDelay(20, null, mid)).toBe(30_000);
    expect(reconnectDelay(0, 5000, mid)).toBe(5000);
  });

  it('adds jitter within ±30%', () => {
    expect(reconnectDelay(2, null, () => 0)).toBe(2800);
    expect(reconnectDelay(2, null, () => 1)).toBe(5200);
  });
});
