/**
 * Bunny Database API client — creates and provisions libSQL databases.
 * Used by the site builder to automatically provision a database for each new site.
 *
 * API base: https://api.bunny.net/database
 * Auth: AccessKey header (same BUNNY_API_KEY as CDN API)
 */

import { parseBunnyError } from "#shared/bunny-cdn.ts";
import { getBunnyApiKey } from "#shared/config.ts";
import { fetchText } from "#shared/fetch.ts";
import { getEnv } from "#shared/env.ts";

const DB_API_BASE = "https://api.bunny.net/database";

/** Region to use when creating a new database (short Bunny region code). */
export const getBunnyDbRegion = (): string =>
  getEnv("BUNNY_DB_REGION") ?? "DE";

type DbApiResult<T> = { ok: true } & T | { ok: false; error: string };

interface CreateDbResponse {
  db_id: string;
}

interface GetDbResponse {
  db: {
    db_id: string;
    name: string;
    url: string;
  };
}

interface GenerateTokenResponse {
  token: string;
}

export interface CreateDatabaseResult {
  dbId: string;
  dbUrl: string;
  dbToken: string;
}

/** Headers for all Bunny Database API requests. */
const dbApiHeaders = (): Record<string, string> => ({
  AccessKey: getBunnyApiKey(),
  "Content-Type": "application/json",
});

/**
 * Create a new Bunny database with the given name.
 * Returns the database URL and a full-access token.
 */
const createDatabaseImpl = async (
  name: string,
): Promise<DbApiResult<CreateDatabaseResult>> => {
  const region = getBunnyDbRegion();

  // 1. Create the database
  const createRes = await fetchText(`${DB_API_BASE}/v2/databases`, {
    body: JSON.stringify({
      name,
      primary_regions: [region],
      replicas_regions: [],
      storage_region: region,
    }),
    headers: dbApiHeaders(),
    method: "POST",
  });

  if (!createRes.ok) {
    return parseBunnyError(createRes, "Create database");
  }

  const createData: CreateDbResponse = JSON.parse(createRes.text);
  const dbId = createData.db_id;

  // 2. Fetch database details to get the connection URL
  const getRes = await fetchText(`${DB_API_BASE}/v2/databases/${encodeURIComponent(dbId)}`, {
    headers: dbApiHeaders(),
  });

  if (!getRes.ok) {
    return parseBunnyError(getRes, "Get database");
  }

  const getData: GetDbResponse = JSON.parse(getRes.text);
  const dbUrl = getData.db.url;

  // 3. Generate a full-access token
  const tokenRes = await fetchText(
    `${DB_API_BASE}/v2/databases/${encodeURIComponent(dbId)}/auth/generate`,
    {
      body: JSON.stringify({ authorization: "full-access", expires_at: null }),
      headers: dbApiHeaders(),
      method: "PUT",
    },
  );

  if (!tokenRes.ok) {
    return parseBunnyError(tokenRes, "Generate database token");
  }

  const tokenData: GenerateTokenResponse = JSON.parse(tokenRes.text);

  return { dbId, dbToken: tokenData.token, dbUrl, ok: true };
};

/** Stubbable API for testing */
export const bunnyDbApi = {
  createDatabase: createDatabaseImpl,
};
