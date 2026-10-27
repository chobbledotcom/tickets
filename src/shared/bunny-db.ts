/**
 * Bunny Database API client — creates and provisions libSQL databases.
 * Used by the site builder to automatically provision a database for each new site.
 *
 * API base: https://api.bunny.net/database
 * Auth: AccessKey header (same BUNNY_API_KEY as CDN API)
 */

/* jscpd:ignore-start -- import block */
import * as v from "valibot";
import { defineApiClient } from "#shared/api-client.ts";
import { bunnyDryRunFetch } from "#shared/bunny-api.ts";
import { getBunnyApiKey } from "#shared/config.ts";
import { jsonHeaders } from "#shared/fetch.ts";
import {
  type CreateDatabaseFn,
  type DatabaseProviderApi,
  databaseCredentialsFromResponse,
} from "#shared/provider-types.ts";
import { okResult, type Result } from "#shared/result.ts";

/* jscpd:ignore-end */

const DB_API_BASE = "https://api.bunny.net/database";

/** The shared Bunny Database client: AccessKey auth, the Bunny `Message`
 * error key, and the site-build dry-run seam. */
const dbClient = defineApiClient({
  baseUrl: DB_API_BASE,
  errorKeys: ["Message"],
  fetchImpl: bunnyDryRunFetch,
  headers: () => jsonHeaders({ AccessKey: getBunnyApiKey() }),
});

/**
 * Storage region for new databases. Bunny only exposes two storage zones —
 * `eu-west-1` (EU) and `us-east-1` (NA) — confirmed via
 * `GET /database/v1/config`. See scripts/bunny-regions.ts.
 */
export const STORAGE_REGION = "eu-west-1";

/** One region Bunny reports it can host a database node in. */
const RegionConfigSchema = v.object({ id: v.string() });

/** The regions Bunny will accept, from GET /database/v1/config. */
const DbConfigResponseSchema = v.object({
  primary_regions: v.array(RegionConfigSchema),
  replica_regions: v.array(RegionConfigSchema),
});

type RegionConfig = v.InferOutput<typeof RegionConfigSchema>;

const CreateDbResponseSchema = v.object({ db_id: v.string() });

const GetDbResponseSchema = v.object({
  db: v.object({
    db_id: v.string(),
    name: v.string(),
    url: v.string(),
  }),
});

/** Just the node IDs from a list of regions Bunny reported. */
const regionIds = (regions: RegionConfig[]): string[] =>
  regions.map((region) => region.id);

/**
 * Ask Bunny which database regions it will accept right now, so a new database
 * runs on every one of Bunny's servers instead of a fixed list. Reading the
 * live config means new Bunny regions are used automatically, with no code
 * change needed when Bunny adds a server.
 */
const getAllRegions = async (): Promise<
  Result<{ primaryRegions: string[]; replicaRegions: string[] }>
> => {
  const config = await dbClient.request(
    "/v1/config",
    { method: "GET" },
    DbConfigResponseSchema,
    "Get database config",
  );
  if (!config.ok) return config;
  return okResult({
    primaryRegions: regionIds(config.value.primary_regions),
    replicaRegions: regionIds(config.value.replica_regions),
  });
};

/**
 * Create a new Bunny database with the given name.
 * Returns the database URL and a full-access token.
 */
const createDatabaseImpl: CreateDatabaseFn = async (name) => {
  // 1. Find every region Bunny will accept, so the database runs everywhere
  const regions = await getAllRegions();
  if (!regions.ok) {
    return regions;
  }

  // 2. Create the database with all of Bunny's nodes as primaries and replicas
  const created = await dbClient.request(
    "/v2/databases",
    {
      body: JSON.stringify({
        name,
        primary_regions: regions.value.primaryRegions,
        replicas_regions: regions.value.replicaRegions,
        storage_region: STORAGE_REGION,
      }),
      method: "POST",
    },
    CreateDbResponseSchema,
    "Create database",
  );
  if (!created.ok) return created;
  const dbId = created.value.db_id;

  // 3. Fetch database details to get the connection URL
  const details = await dbClient.request(
    `/v2/databases/${encodeURIComponent(dbId)}`,
    { method: "GET" },
    GetDbResponseSchema,
    "Get database",
  );
  if (!details.ok) return details;
  const dbUrl = details.value.db.url;

  // 4. Generate a full-access token
  const tokenRes = await dbClient.fetch(
    `/v2/databases/${encodeURIComponent(dbId)}/auth/generate`,
    {
      body: JSON.stringify({ authorization: "full-access", expires_at: null }),
      method: "PUT",
    },
    "Generate database token",
  );
  if (!tokenRes.ok) return tokenRes;

  return databaseCredentialsFromResponse(
    dbId,
    dbUrl,
    tokenRes.value.text,
    "token",
  );
};

export const bunnyDbProvider: DatabaseProviderApi = {
  createDatabase: createDatabaseImpl,
};
