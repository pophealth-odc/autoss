import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { detectEdge } from '../browser/edge.js';
import { deleteProfile, listProfiles } from '../browser/profiles.js';
import { resolveSettings } from '../automation/settings.js';
import type { RunController } from '../automation/run-controller.js';
import type { ServiceConfig } from '../config.js';
import { ApiError, notFound, validationFailed } from '../errors.js';
import type { EventHub } from '../events/event-hub.js';
import type { Logger } from '../logger.js';
import {
  API_VERSION,
  LIMITS,
  SERVICE_FEATURES,
  SERVICE_ID,
  type GalleryItem,
  type GalleryListResponse,
  type ServiceEvent,
  type ServiceHealth,
  type ServiceInfo,
} from '../shared/contract.js';
import { isValidId, type GalleryStore } from '../storage/gallery-store.js';
import type { ThumbnailService } from '../storage/thumbnails.js';
import { buildIndexCsv, buildZipNames, streamZip, type ZipFileEntry } from './zip.js';

export interface RouteDeps {
  config: ServiceConfig;
  store: GalleryStore;
  runs: RunController;
  hub: EventHub;
  thumbnails: ThumbnailService;
  logger: Logger;
  startedAt: number;
}

const idsSchema = z.strictObject({
  ids: z.array(z.string().min(1).max(64)).max(LIMITS.maxDeleteIds),
});
const zipSchema = z.strictObject({
  ids: z.array(z.string().min(1).max(64)).max(LIMITS.maxZipEntries).optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw validationFailed(
      result.error.issues[0]?.message ?? 'The request is not valid.',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

function idParam(req: Request): string {
  const id = req.params['id'];
  if (typeof id !== 'string' || !isValidId(id)) throw notFound('No such screenshot.');
  return id;
}

/** Header-safe `Content-Disposition` with an ASCII fallback and an RFC 5987 UTF-8 name. */
export function attachmentHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function sendBinary(res: Response, filePath: string, contentType: string, disposition: string | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.once('open', () => {
      res.setHeader('Content-Type', contentType);
      if (disposition) res.setHeader('Content-Disposition', disposition);
      stream.pipe(res);
    });
    stream.once('error', (error) => {
      if (res.headersSent) res.destroy(error);
      reject(error);
    });
    res.once('close', () => {
      stream.destroy();
      resolve();
    });
  });
}

async function imageFile(deps: RouteDeps, item: GalleryItem): Promise<{ path: string; size: number }> {
  const path = await deps.store.imagePath(item);
  try {
    const stat = await fs.stat(path);
    return { path, size: stat.size };
  } catch {
    throw new ApiError(404, 'not_found', 'The screenshot file is missing from the screenshots folder.');
  }
}

export function createApiRouter(deps: RouteDeps): { authed: Router; open: Router } {
  const open = Router();
  const authed = Router();

  // ---------------------------------------------------------------------------------------------------------------
  // Unauthenticated: just enough for the UI to tell "service not running" from "wrong token".
  // ---------------------------------------------------------------------------------------------------------------
  open.get('/health', (_req, res) => {
    const body: ServiceHealth = {
      ok: true,
      service: SERVICE_ID,
      version: deps.config.version,
      apiVersion: API_VERSION,
      features: [...SERVICE_FEATURES],
      authRequired: true,
      time: new Date().toISOString(),
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // System
  // ---------------------------------------------------------------------------------------------------------------
  authed.get('/system/info', async (_req, res) => {
    const edge = await detectEdge({ explicitPath: deps.config.edgePath });
    const body: ServiceInfo = {
      version: deps.config.version,
      apiVersion: API_VERSION,
      platform: process.platform,
      nodeVersion: process.version,
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      edge,
      screenshotsDir: deps.config.screenshotsDir,
      profilesDir: deps.config.profilesDir,
      privateTargetsAllowed: deps.config.allowPrivateTargets,
      allowedTargetHosts: deps.config.allowedTargetHosts,
      thumbnailsAvailable: await deps.thumbnails.isAvailable(),
      maxFullPageHeight: deps.config.maxFullPageHeight,
      allowedOrigins: deps.config.allowedOrigins,
      allowLocalhostOrigins: deps.config.allowLocalhostOrigins,
      limits: LIMITS,
    };
    res.json(body);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Live events (Server-Sent Events)
  // ---------------------------------------------------------------------------------------------------------------
  authed.get('/events', (req, res) => {
    if (!deps.hub.hasCapacity) {
      throw new ApiError(429, 'too_many_streams', 'Too many browser tabs are connected to this service.');
    }
    const last = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10);
    const initial: ServiceEvent[] = [
      { type: 'hello', data: { serverTime: new Date().toISOString(), version: deps.config.version, apiVersion: API_VERSION } },
      { type: 'state', data: deps.runs.snapshot() },
    ];
    deps.hub.subscribe(res, Number.isFinite(last) ? last : null, initial);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Automation
  // ---------------------------------------------------------------------------------------------------------------
  authed.post('/automation/start', async (req, res) => {
    const resolved = resolveSettings(req.body);
    if (!resolved.ok) {
      throw validationFailed(resolved.issues[0]?.message ?? 'The settings are not valid.', resolved.issues);
    }
    const status = await deps.runs.start(resolved.settings);
    res.status(202).json(status);
  });

  authed.post('/automation/stop', (_req, res) => {
    res.json(deps.runs.stop());
  });

  authed.post('/automation/continue', (_req, res) => {
    res.json(deps.runs.continueRun());
  });

  authed.get('/automation/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(deps.runs.snapshot());
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Gallery
  // ---------------------------------------------------------------------------------------------------------------
  authed.get('/gallery', (_req, res) => {
    const body: GalleryListResponse = {
      items: deps.store.list(),
      total: deps.store.count,
      totalBytes: deps.store.totalBytes(),
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });

  authed.get('/gallery/:id/image', async (req, res) => {
    const item = deps.store.get(idParam(req));
    if (!item) throw notFound('No such screenshot.');
    const file = await imageFile(deps, item);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Cache-Control', 'private, max-age=3600, immutable');
    await sendBinary(res, file.path, 'image/png', null);
  });

  authed.get('/gallery/:id/thumbnail', async (req, res) => {
    const item = deps.store.get(idParam(req));
    if (!item) throw notFound('No such screenshot.');
    const file = await imageFile(deps, item);
    const jpeg = await deps.thumbnails.get(item.id, file.path, deps.store.thumbnailPath(item.id));
    res.setHeader('Cache-Control', 'private, max-age=3600, immutable');
    if (jpeg) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', String(jpeg.length));
      res.end(jpeg);
      return;
    }
    // No thumbnail support: serve the original so the card still shows something.
    res.setHeader('Content-Length', String(file.size));
    await sendBinary(res, file.path, 'image/png', null);
  });

  authed.get('/gallery/:id/download', async (req, res) => {
    const item = deps.store.get(idParam(req));
    if (!item) throw notFound('No such screenshot.');
    const file = await imageFile(deps, item);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Cache-Control', 'no-store');
    await sendBinary(res, file.path, 'image/png', attachmentHeader(item.filename));
  });

  authed.post('/gallery/download-zip', async (req, res) => {
    const { ids } = parseBody(zipSchema, req.body);
    const wanted = ids && ids.length > 0 ? [...new Set(ids)] : null;

    let items: GalleryItem[];
    if (wanted) {
      items = [];
      for (const id of wanted) {
        const item = isValidId(id) ? deps.store.get(id) : undefined;
        if (item) items.push(item);
      }
      if (items.length === 0) throw notFound('None of the selected screenshots exist any more.');
    } else {
      items = deps.store.list();
      if (items.length === 0) throw new ApiError(404, 'not_found', 'The gallery is empty, so there is nothing to download.');
    }
    if (items.length > LIMITS.maxZipEntries) {
      throw validationFailed(`A ZIP file can hold at most ${LIMITS.maxZipEntries} screenshots. Select fewer screenshots.`);
    }

    // Oldest first, so the file names sort chronologically in Explorer.
    items.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const names = buildZipNames(items);
    const entries: ZipFileEntry[] = [];
    for (const [index, item] of items.entries()) {
      const file = await imageFile(deps, item).catch(() => null);
      if (!file) continue; // file vanished since the gallery was loaded: leave it out of the archive and the listing
      entries.push({ absPath: file.path, name: names[index] as string, item });
    }
    if (entries.length === 0) throw new ApiError(404, 'not_found', 'The screenshot files are missing from the screenshots folder.');

    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', attachmentHeader(`screenshots-${stamp}.zip`));
    res.setHeader('Cache-Control', 'no-store');
    await streamZip(
      res,
      entries,
      [{ name: 'index.csv', content: buildIndexCsv(entries) }],
      (error) => deps.logger.error('ZIP download failed', { error: error.message }),
    );
  });

  authed.post('/gallery/delete', async (req, res) => {
    const { ids } = parseBody(idsSchema, req.body);
    if (ids.length === 0) throw validationFailed('Select at least one screenshot to delete.');
    const result = await deps.store.remove(ids.filter(isValidId));
    publishDeleted(deps, ids, result.deleted);
    res.json({ ...result, missing: [...result.missing, ...ids.filter((id) => !isValidId(id))] });
  });

  authed.delete('/gallery/:id', async (req, res) => {
    const id = idParam(req);
    const result = await deps.store.remove([id]);
    if (result.deleted === 0) throw notFound('No such screenshot.');
    publishDeleted(deps, [id], result.deleted);
    res.json(result);
  });

  authed.delete('/gallery', async (req, res) => {
    if (req.query['confirm'] !== 'true') {
      throw new ApiError(400, 'confirmation_required', 'Clearing the gallery needs ?confirm=true.');
    }
    const ids = deps.store.list().map((item) => item.id);
    const result = await deps.store.clear();
    deps.hub.publish({ type: 'gallery', data: { reason: 'cleared', ids } });
    res.json(result);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Browser profiles
  // ---------------------------------------------------------------------------------------------------------------
  authed.get('/profiles', async (_req, res) => {
    res.json({ profiles: await listProfiles(deps.config.profilesDir) });
  });

  authed.delete('/profiles/:name', async (req, res) => {
    const name = req.params['name'];
    if (typeof name !== 'string') throw notFound('No such profile.');
    if (deps.runs.isActive) throw new ApiError(409, 'conflict', 'Stop the run before deleting a browser profile.');
    const deleted = await deleteProfile(deps.config.profilesDir, name);
    if (!deleted) throw notFound('No such profile.');
    res.json({ deleted });
  });

  return { open, authed };
}

function publishDeleted(deps: RouteDeps, ids: string[], deleted: number): void {
  if (deleted > 0) deps.hub.publish({ type: 'gallery', data: { reason: 'deleted', ids } });
}
