/**
 * Edge-specific libsql cache layer
 * For use with Bunny Edge Script runtime
 */

import { type Client, createClient } from "@libsql/client/web";
import { CACHE_HOST, CACHE_TTL_MS } from "../lib/constants.ts";
import type { CacheRow, TagResult } from "../lib/types.ts";

let db: Client | null = null;

/**
 * Get or create database client
 */
export const getDb = (): Client => {
  if (!db) {
    db = createClient({
      url: process.env.DB_URL!,
      authToken: process.env.DB_TOKEN,
    });
  }
  return db;
};

/**
 * Initialize cache table
 */
export const initCache = async (): Promise<void> => {
  await getDb().execute(`
    CREATE TABLE IF NOT EXISTS cache (
      host TEXT NOT NULL,
      id TEXT NOT NULL,
      cached TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (host, id)
    )
  `);
};

/**
 * Read cached tag data if fresh
 */
export const readCache = async (tagId: string): Promise<TagResult | null> => {
  const result = await getDb().execute({
    sql: "SELECT json, cached FROM cache WHERE host = ? AND id = ?",
    args: [CACHE_HOST, tagId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as unknown as CacheRow;
  const cachedAt = new Date(row.cached).getTime();
  const age = Date.now() - cachedAt;

  if (age > CACHE_TTL_MS) return null;

  return { ...JSON.parse(row.json), fromCache: true };
};

/**
 * Write tag data to cache
 */
export const writeCache = async (
  tagId: string,
  data: TagResult,
): Promise<void> => {
  await getDb().execute({
    sql: "INSERT OR REPLACE INTO cache (host, id, cached, json) VALUES (?, ?, ?, ?)",
    args: [CACHE_HOST, tagId, new Date().toISOString(), JSON.stringify(data)],
  });
};
