/**
 * Bunny Database API client — creates and provisions libSQL databases.
 * Used by the site builder to automatically provision a database for each new site.
 *
 * API base: https://api.bunny.net/database
 * Auth: AccessKey header (same BUNNY_API_KEY as CDN API)
 */

import { map } from "#fp";
import { parseBunnyError } from "#shared/bunny-cdn.ts";
import { getBunnyApiKey } from "#shared/config.ts";
import { fetchText } from "#shared/fetch.ts";

const DB_API_BASE = "https://api.bunny.net/database";
const CDN_PROBE_URL = "https://bunny.net/index.html";
const CONFIG_API_BASE = "https://api.bunny.net";

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

interface OptimalConfig {
  primary_regions?: Array<{ id: string }>;
  replica_regions?: Array<{ id: string }>;
  storage_region?: { id: string };
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

const mapId = map((r: { id: string }) => r.id);

/** Detect optimal regions via CDN location probe, returning empty arrays on failure. */
const getOptimalRegions = async (): Promise<{
  primaryRegions: string[];
  replicasRegions: string[];
  storageRegion: string | undefined;
}> => {
  const probeRes = await fetch(CDN_PROBE_URL, { method: "HEAD" });
  const cdnToken = probeRes.headers.get("server") ?? "";

  const optimalRes = await fetchText(
    `${CONFIG_API_BASE}/v1/config/optimal?cdn_server_token=${encodeURIComponent(cdnToken)}`,
    { headers: dbApiHeaders() },
  );

  if (!optimalRes.ok) {
    return { primaryRegions: [], replicasRegions: [], storageRegion: undefined };
  }

  const data: OptimalConfig = JSON.parse(optimalRes.text);
  return {
    primaryRegions: mapId(data.primary_regions ?? []),
    replicasRegions: mapId(data.replica_regions ?? []),
    storageRegion: data.storage_region?.id,
  };
};

/**
 * Create a new Bunny database with the given name.
 * Returns the database URL and a full-access token.
 */
const createDatabaseImpl = async (
  name: string,
): Promise<DbApiResult<CreateDatabaseResult>> => {
  const { primaryRegions, replicasRegions, storageRegion } =
    await getOptimalRegions();

  // 1. Create the database
  const createRes = await fetchText(`${DB_API_BASE}/v2/databases`, {
    body: JSON.stringify({
      name,
      primary_regions: primaryRegions,
      replicas_regions: replicasRegions,
      storage_region: storageRegion,
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
  const getRes = await fetchText(
    `${DB_API_BASE}/v2/databases/${encodeURIComponent(dbId)}`,
    { headers: dbApiHeaders() },
  );

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
