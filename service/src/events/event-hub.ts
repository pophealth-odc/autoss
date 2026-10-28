import type { ServerResponse } from 'node:http';
import type { ServiceEvent } from '../shared/contract.js';

interface BufferedEvent {
  id: number;
  event: ServiceEvent;
}

interface Client {
  id: number;
  res: ServerResponse;
  heartbeat: NodeJS.Timeout;
}

export interface EventHubOptions {
  /** Maximum number of simultaneous event streams. */
  maxClients?: number;
  heartbeatMs?: number;
  /** Events kept so a reconnecting client can catch up with Last-Event-ID. */
  replaySize?: number;
}

function frame(id: number, event: ServiceEvent): string {
  // JSON.stringify never emits raw newlines, so one "data:" line is always enough.
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** Fan-out of service events to the connected browser tabs over Server-Sent Events. */
export class EventHub {
  private readonly clients = new Map<number, Client>();
  private readonly buffer: BufferedEvent[] = [];
  private nextEventId = 1;
  private nextClientId = 1;
  private readonly maxClients: number;
  private readonly heartbeatMs: number;
  private readonly replaySize: number;

  constructor(options: EventHubOptions = {}) {
    this.maxClients = options.maxClients ?? 20;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.replaySize = options.replaySize ?? 200;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get hasCapacity(): boolean {
    return this.clients.size < this.maxClients;
  }

  /**
   * Attaches a response as an event stream. `hello` (and the current state) are sent first; `lastEventId` replays missed
   * "capture" and "gallery" events after a reconnect. Returns false if the hub is full (nothing is written then).
   */
  subscribe(res: ServerResponse, lastEventId: number | null, initial: ServiceEvent[]): boolean {
    if (!this.hasCapacity) return false;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    res.socket?.setTimeout(0);
    res.write('retry: 3000\n\n');

    const clientId = this.nextClientId++;
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
    }, this.heartbeatMs);
    heartbeat.unref();
    const client: Client = { id: clientId, res, heartbeat };
    this.clients.set(clientId, client);

    const cleanup = () => {
      clearInterval(heartbeat);
      this.clients.delete(clientId);
    };
    res.once('close', cleanup);
    res.once('error', cleanup);

    // Catch up on events the client missed (only the ones that change the gallery; "state" is always re-sent below).
    if (lastEventId !== null) {
      for (const buffered of this.buffer) {
        if (buffered.id > lastEventId && (buffered.event.type === 'capture' || buffered.event.type === 'gallery')) {
          res.write(frame(buffered.id, buffered.event));
        }
      }
    }
    // The snapshot events carry the id of the latest published event, so a later reconnect resumes right after it.
    const snapshotId = Math.max(0, this.nextEventId - 1);
    for (const event of initial) res.write(frame(snapshotId, event));
    return true;
  }

  publish(event: ServiceEvent): void {
    const id = this.nextEventId++;
    if (event.type === 'capture' || event.type === 'gallery') {
      this.buffer.push({ id, event });
      if (this.buffer.length > this.replaySize) this.buffer.splice(0, this.buffer.length - this.replaySize);
    }
    const text = frame(id, event);
    for (const client of this.clients.values()) {
      if (client.res.writableEnded || client.res.destroyed) continue;
      // A slow reader must not make the service buffer without limit: drop clients that fall far behind.
      if (client.res.writableLength > 1_000_000) {
        client.res.destroy();
        continue;
      }
      client.res.write(text);
    }
  }

  /** Ends every stream. Called on shutdown so the HTTP server can close promptly. */
  closeAll(): void {
    for (const client of this.clients.values()) {
      clearInterval(client.heartbeat);
      client.res.end();
    }
    this.clients.clear();
  }
}
