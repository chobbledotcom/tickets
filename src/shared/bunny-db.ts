/**
 * Bunny Database API client — creates and provisions libSQL databases.
 * Used by the site builder to automatically provision a database for each new site.
 *
 * API base: https://api.bunny.net/database
 * Auth: AccessKey header (same BUNNY_API_KEY as CDN API)
 */

import { parseBunnyError } from "#shared/bunny-cdn.ts";
import { getBunnyApiKey } from "#shared/config.ts";
import { type ApiResult, fetchText } from "#shared/fetch.ts";

const DB_API_BASE = "https://api.bunny.net/database";

/**
 * Storage region for new databases. Bunny only exposes two storage zones —
 * `eu-west-1` (EU) and `us-east-1` (NA) — confirmed via
 * `GET /database/v1/config`. See scripts/bunny-regions.ts.
 */
export const STORAGE_REGION = "eu-west-1";

/** All European Bunny database node IDs. */
export const EUROPEAN_REGIONS = [
  "AMS",
  "AT",
  "BU",
  "CZ",
  "DE",
  "DK",
  "ES",
  "FR",
  "GR",
  "HR",
  "IT",
  "PL",
  "SE",
  "UK",
];

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
): Promise<ApiResult<CreateDatabaseResult>> => {
  // 1. Create the database with all European nodes as primaries and replicas
  const createRes = await fetchText(`${DB_API_BASE}/v2/databases`, {
    body: JSON.stringify({
      name,
      primary_regions: EUROPEAN_REGIONS,
      replicas_regions: EUROPEAN_REGIONS,
      storage_region: STORAGE_REGION,
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
