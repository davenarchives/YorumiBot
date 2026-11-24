import express from 'express';
import { neon } from '@neondatabase/serverless';
import { logger } from '../utils/logger.js';

let cachedSql = null;
let cachedUrl = '';
let schemaInitPromise = null;

const getSyncDatabaseUrl = () =>
  String(
    process.env.YORUMI_SYNC_DATABASE_URL ||
      process.env.NEON_DATABASE_URL ||
      process.env.DATABASE_URL ||
      ''
  ).trim();

const getSyncDirectDatabaseUrl = () =>
  String(
    process.env.YORUMI_SYNC_DATABASE_URL_UNPOOLED ||
      process.env.NEON_DATABASE_URL_UNPOOLED ||
      process.env.DATABASE_URL_UNPOOLED ||
      ''
  ).trim() || getSyncDatabaseUrl();

const isNeonConfigured = () => Boolean(getSyncDatabaseUrl());

const getNeonSql = () => {
  const url = getSyncDatabaseUrl();
  if (!url) return null;
  if (!cachedSql || cachedUrl !== url) {
    cachedSql = neon(url);
    cachedUrl = url;
    schemaInitPromise = null;
  }
  return cachedSql;
};

const ensureNeonSchema = async () => {
  const directUrl = getSyncDirectDatabaseUrl();
  if (!directUrl) return;
  if (!schemaInitPromise) {
    const schemaSql = directUrl === getSyncDatabaseUrl() ? getNeonSql() : neon(directUrl);
    schemaInitPromise = (async () => {
      await schemaSql`
        CREATE TABLE IF NOT EXISTS yorumi_users (
          discord_id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          handle TEXT,
          avatar_url TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await schemaSql`
        CREATE TABLE IF NOT EXISTS yorumi_library_sync (
          discord_id TEXT PRIMARY KEY REFERENCES yorumi_users(discord_id) ON DELETE CASCADE,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      logger.info('[YorumiSync] Neon schema verified');
    })().catch((err) => {
      schemaInitPromise = null;
      throw err;
    });
  }
  await schemaInitPromise;
};

const mapRowToPublicProfile = (row) => {
  const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const firstSeenMs = Number(p.yorumi_profile_first_seen_v1 || 0);
  const creationTime =
    Number.isFinite(firstSeenMs) && firstSeenMs > 0
      ? new Date(firstSeenMs).toISOString()
      : row.updated_at
        ? new Date(row.updated_at).toISOString()
        : null;

  return {
    uid: String(row.discord_id),
    displayName: String(row.username || row.handle || 'Yorumi User'),
    email: '',
    avatar: row.avatar_url || null,
    banner: null,
    profileCardBackground: null,
    creationTime,
    watchList: Array.isArray(p.yorumi_watch_list) ? p.yorumi_watch_list : [],
    readList: Array.isArray(p.yorumi_read_list) ? p.yorumi_read_list : [],
    lnReadList: Array.isArray(p.yorumi_ln_read_list_v1) ? p.yorumi_ln_read_list_v1 : [],
    continueWatching: Array.isArray(p.yorumi_continue_watching) ? p.yorumi_continue_watching : [],
    continueReading: Array.isArray(p.yorumi_continue_reading) ? p.yorumi_continue_reading : [],
    continueLN: Array.isArray(p.yorumi_ln_continue_reading_v1) ? p.yorumi_ln_continue_reading_v1 : [],
    episodeHistory: p.yorumi_episode_history && typeof p.yorumi_episode_history === 'object' ? p.yorumi_episode_history : {},
    chapterHistory: p.yorumi_chapter_history && typeof p.yorumi_chapter_history === 'object' ? p.yorumi_chapter_history : {},
    animeWatchTime: p.yorumi_anime_watch_time && typeof p.yorumi_anime_watch_time === 'object' ? p.yorumi_anime_watch_time : {},
    animeWatchTimeTotalSeconds: Number(p.yorumi_anime_watch_time_total || 0) || 0,
    animeGenreCache: p.yorumi_anime_genre_cache && typeof p.yorumi_anime_genre_cache === 'object' ? p.yorumi_anime_genre_cache : {},
    animeCompletionCache: {},
    mangaCompletionCache: {},
    mangaGenreCache: p.yorumi_manga_genre_cache && typeof p.yorumi_manga_genre_cache === 'object' ? p.yorumi_manga_genre_cache : {},
    activityHistory: p.yorumi_activity_history && typeof p.yorumi_activity_history === 'object' ? p.yorumi_activity_history : {},
    favoriteAnime: Array.isArray(p.yorumi_favorite_anime) ? p.yorumi_favorite_anime : [],
    favoriteManga: Array.isArray(p.yorumi_favorite_manga) ? p.yorumi_favorite_manga : [],
    favoriteLN: Array.isArray(p.yorumi_favorite_ln) ? p.yorumi_favorite_ln : [],
    libraryCategories: p.yorumi_library_categories_v1 && typeof p.yorumi_library_categories_v1 === 'object' ? p.yorumi_library_categories_v1 : undefined,
  };
};

export function createYorumiSyncRouter(verifyChatToken) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  const resolveAuthenticatedUser = (req) => {
    const authHeader = String(req.headers.authorization || '').trim();
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const token = bearerMatch?.[1]?.trim() || '';
    if (!token) return null;
    const raw = verifyChatToken(token);
    if (!raw?.id || !raw?.username) return null;
    return {
      id: String(raw.id),
      username: String(raw.username),
      handle: raw.handle ? String(raw.handle) : undefined,
      avatar: raw.avatar ? String(raw.avatar) : undefined,
    };
  };

  router.get('/health', async (_req, res) => {
    const sql = getNeonSql();
    if (!sql) {
      return res.status(200).json({
        success: false,
        data: { configured: false, connected: false, error: 'DATABASE_URL is not configured' },
      });
    }
    const startedAt = Date.now();
    try {
      await ensureNeonSchema();
      await sql`SELECT 1 AS ok`;
      return res.status(200).json({
        success: true,
        data: { configured: true, connected: true, latencyMs: Date.now() - startedAt },
      });
    } catch (err) {
      return res.status(503).json({
        success: false,
        data: {
          configured: true,
          connected: false,
          latencyMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });

  router.get('/library', async (req, res) => {
    if (!isNeonConfigured()) {
      return res.status(503).json({ success: false, error: 'Neon database is not configured' });
    }
    const user = resolveAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid or missing Discord session token' });
    }

    try {
      await ensureNeonSchema();
      const sql = getNeonSql();
      const rows = await sql`
        SELECT payload, updated_at
        FROM yorumi_library_sync
        WHERE discord_id = ${user.id}
        LIMIT 1
      `;
      const row = rows[0];
      return res.json({
        success: true,
        data: {
          user,
          payload: row?.payload || null,
          updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
        },
      });
    } catch (err) {
      logger.error('[YorumiSync] Failed to fetch library from Neon:', err);
      return res.status(500).json({ success: false, error: 'Failed to load cloud library' });
    }
  });

  router.put('/library', async (req, res) => {
    if (!isNeonConfigured()) {
      return res.status(503).json({ success: false, error: 'Neon database is not configured' });
    }
    const user = resolveAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid or missing Discord session token' });
    }

    const payload = req.body?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ success: false, error: 'Body must include a JSON object "payload"' });
    }

    try {
      await ensureNeonSchema();
      const sql = getNeonSql();
      await sql`
        INSERT INTO yorumi_users (discord_id, username, handle, avatar_url, updated_at)
        VALUES (${user.id}, ${user.username}, ${user.handle || null}, ${user.avatar || null}, NOW())
        ON CONFLICT (discord_id) DO UPDATE SET
          username = EXCLUDED.username,
          handle = EXCLUDED.handle,
          avatar_url = EXCLUDED.avatar_url,
          updated_at = NOW()
      `;
      const rows = await sql`
        INSERT INTO yorumi_library_sync (discord_id, payload, updated_at)
        VALUES (${user.id}, ${JSON.stringify(payload)}::jsonb, NOW())
        ON CONFLICT (discord_id) DO UPDATE SET
          payload = EXCLUDED.payload,
          updated_at = NOW()
        RETURNING updated_at
      `;
      const updatedAt = rows[0]?.updated_at;
      return res.json({
        success: true,
        data: {
          ok: true,
          updatedAt: updatedAt ? new Date(updatedAt).toISOString() : new Date().toISOString(),
        },
      });
    } catch (err) {
      logger.error('[YorumiSync] Failed to save library to Neon:', err);
      return res.status(500).json({ success: false, error: 'Failed to save cloud library' });
    }
  });

  router.delete('/library', async (req, res) => {
    if (!isNeonConfigured()) {
      return res.status(503).json({ success: false, error: 'Neon database is not configured' });
    }
    const user = resolveAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid or missing Discord session token' });
    }

    try {
      await ensureNeonSchema();
      const sql = getNeonSql();
      await sql`DELETE FROM yorumi_library_sync WHERE discord_id = ${user.id}`;
      return res.json({ success: true, data: { deleted: true } });
    } catch (err) {
      logger.error('[YorumiSync] Failed to delete library from Neon:', err);
      return res.status(500).json({ success: false, error: 'Failed to delete cloud library' });
    }
  });

  router.get('/users', async (req, res) => {
    if (!isNeonConfigured()) {
      return res.json({ success: true, data: [] });
    }
    const q = String(req.query.q || '').trim();
    const limit = Math.min(30, Math.max(1, Number.parseInt(String(req.query.limit || '15'), 10) || 15));

    try {
      await ensureNeonSchema();
      const sql = getNeonSql();
      const pattern = `%${q}%`;
      const rows = q
        ? await sql`
            SELECT u.discord_id, u.username, u.handle, u.avatar_url, u.updated_at, s.payload
            FROM yorumi_users u
            LEFT JOIN yorumi_library_sync s ON s.discord_id = u.discord_id
            WHERE u.username ILIKE ${pattern} OR COALESCE(u.handle, '') ILIKE ${pattern}
            ORDER BY u.updated_at DESC
            LIMIT ${limit}
          `
        : await sql`
            SELECT u.discord_id, u.username, u.handle, u.avatar_url, u.updated_at, s.payload
            FROM yorumi_users u
            LEFT JOIN yorumi_library_sync s ON s.discord_id = u.discord_id
            ORDER BY u.updated_at DESC
            LIMIT ${limit}
          `;

      return res.json({ success: true, data: rows.map(mapRowToPublicProfile) });
    } catch (err) {
      logger.error('[YorumiSync] Failed to search users in Neon:', err);
      return res.status(500).json({ success: false, error: 'Failed to search users' });
    }
  });

  router.get('/users/:uid', async (req, res) => {
    if (!isNeonConfigured()) {
      return res.status(404).json({ success: false, error: 'User database is not configured' });
    }
    const uid = String(req.params.uid || '').trim();
    if (!uid) {
      return res.status(400).json({ success: false, error: 'Missing uid' });
    }

    try {
      await ensureNeonSchema();
      const sql = getNeonSql();
      const rows = await sql`
        SELECT u.discord_id, u.username, u.handle, u.avatar_url, u.updated_at, s.payload
        FROM yorumi_users u
        LEFT JOIN yorumi_library_sync s ON s.discord_id = u.discord_id
        WHERE u.discord_id = ${uid}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
      return res.json({ success: true, data: mapRowToPublicProfile(row) });
    } catch (err) {
      logger.error('[YorumiSync] Failed to fetch user profile from Neon:', err);
      return res.status(500).json({ success: false, error: 'Failed to fetch user profile' });
    }
  });

  return router;
}
