/**
 * Turso API client — creates hosted libSQL databases via the Turso platform API.
 * Used by the site builder as an alternative database provider to Bunny DB.
 *
 * API base: https://api.turso.tech
 * Auth: Authorization: Bearer {TURSO_API_TOKEN}
 */

import type { CreateDatabaseResult } from "#shared/bunny-db.ts";
import {
  getTursoApiToken,
  getTursoGroup,
  getTursoOrganization,
} from "#shared/config.ts";
import { type ApiResult, fetchText, parseApiError } from "#shared/fetch.ts";

const TURSO_API_BASE = "https://api.turso.tech";

interface CreateTursoDbResponse {
  database: {
    DbId: string;
    Hostname: string;
    Name: string;
  };
}

interface CreateTursoTokenResponse {
  jwt: string;
}

/** Headers for all Turso API requests. */
const tursoApiHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${getTursoApiToken()}`,
  "Content-Type": "application/json",
});

/**
 * Create a new Turso database with the given name.
 * Returns the database URL and a full-access JWT token.
 */
const createDatabaseImpl = async (
  name: string,
): Promise<ApiResult<CreateDatabaseResult>> => {
  const org = getTursoOrganization();
  const group = getTursoGroup();

  // 1. Create the database
  const createRes = await fetchText(
    `${TURSO_API_BASE}/v1/organizations/${encodeURIComponent(org)}/databases`,
    {
      body: JSON.stringify({ group, name }),
      headers: tursoApiHeaders(),
      method: "POST",
    },
  );

  if (!createRes.ok) {
    return parseApiError(createRes, "Create database", ["error", "message"]);
  }

  const createData: CreateTursoDbResponse = JSON.parse(createRes.text);
  const { DbId: dbId, Hostname: hostname, Name: dbName } = createData.database;
  const dbUrl = `libsql://${hostname}`;

  // 2. Generate a full-access token
  const tokenRes = await fetchText(
    `${TURSO_API_BASE}/v1/organizations/${encodeURIComponent(org)}/databases/${encodeURIComponent(
      dbName,
    )}/auth/tokens?authorization=full-access`,
    {
      headers: tursoApiHeaders(),
      method: "POST",
    },
  );

  if (!tokenRes.ok) {
    return parseApiError(tokenRes, "Generate database token", [
      "error",
      "message",
    ]);
  }

  const tokenData: CreateTursoTokenResponse = JSON.parse(tokenRes.text);

  return { dbId, dbToken: tokenData.jwt, dbUrl, ok: true };
};

/** Stubbable API for testing */
export const tursoApi = {
  createDatabase: createDatabaseImpl,
};
