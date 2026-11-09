/** Turso platform API client used by site provisioning and database migration. */

import * as v from "valibot";
import { type ListedDatabase, requireListedDatabase } from "#db/host.ts";
import { type ApiRequestInit, defineApiClient } from "#shared/api-client.ts";
import {
  getTursoApiToken,
  getTursoGroup,
  getTursoOrganization,
  tursoDatabaseSlug,
} from "#shared/config.ts";
import { errorMessage } from "#shared/error-message.ts";
import { type FetchResult, jsonHeaders, parseApiError } from "#shared/fetch.ts";
import type {
  CreateDatabaseFn,
  DatabaseCredentials,
  DatabaseProviderApi,
  RotateDatabaseKeyFn,
} from "#shared/provider-types.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

const TURSO_API_BASE = "https://api.turso.tech";

const TursoHostnameSchema = v.pipe(
  NonEmptyTextSchema,
  v.check((value) => {
    try {
      const url = new URL(`https://${value}`);
      return url.hostname === value && url.port === "";
    } catch {
      return false;
    }
  }),
);
const TursoDatabaseSchema = v.object({
  DbId: NonEmptyTextSchema,
  Hostname: TursoHostnameSchema,
  Name: NonEmptyTextSchema,
});
const CreateTursoDatabaseSchema = v.object({ database: TursoDatabaseSchema });
const TursoTokenSchema = v.object({ jwt: NonEmptyTextSchema });
const TursoOrganizationsSchema = v.array(
  v.object({ slug: NonEmptyTextSchema }),
);
const TursoDatabaseListSchema = v.object({
  databases: v.array(TursoDatabaseSchema),
});
const TursoGroupsSchema = v.object({
  groups: v.array(v.object({ name: NonEmptyTextSchema })),
});

export interface CreateTursoDatabaseRequest {
  group: string;
  name: string;
  organization: string;
  seed?: "database_upload";
}

export interface TursoDatabaseCredentials extends DatabaseCredentials {
  name: string;
}

/** Answer one full-access token for the named database. */
type DatabaseTokenFn = (
  organization: string,
  name: string,
) => Promise<Result<string>>;

export interface TursoApi {
  createDatabase(
    request: CreateTursoDatabaseRequest,
  ): Promise<Result<TursoDatabaseCredentials>>;
  databaseExists(organization: string, name: string): Promise<Result<boolean>>;
  deleteDatabase(organization: string, name: string): Promise<Result<void>>;
  listGroups(organization: string): Promise<Result<string[]>>;
  listOrganizations(): Promise<Result<string[]>>;
}

/** The calls that replace one database's key. Only key rotation asks them. */
interface TursoDatabaseKeyApi {
  listDatabases(organization: string): Promise<Result<ListedDatabase[]>>;
  /** Replace every token for one database with one new full-access token. */
  rotateDatabaseKey: DatabaseTokenFn;
}

const parseResponse = <Output>(
  schema: v.GenericSchema<unknown, Output>,
  text: string,
  label: string,
): Output => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  const result = v.safeParse(schema, parsed);
  if (!result.success) throw new Error(`${label} returned an invalid response`);
  return result.output;
};

const databasePath = (organization: string, name = ""): string =>
  `/v1/organizations/${encodeURIComponent(organization)}/databases${
    name ? `/${encodeURIComponent(name)}` : ""
  }`;

const namesFrom = <Entry>(
  entries: Entry[],
  getName: (entry: Entry) => string,
): string[] => entries.map(getName);

/** Build a Turso client around one platform API token. The optional signal
 * cancels in-flight requests. Cleanup deletes always ignore it so an
 * incomplete destination can still be removed after an interrupt. */
export const createTursoApi = (
  apiToken: string,
  signal?: AbortSignal,
): TursoApi & TursoDatabaseKeyApi => {
  const client = defineApiClient({
    baseUrl: TURSO_API_BASE,
    headers: () => jsonHeaders({ Authorization: `Bearer ${apiToken}` }),
  });
  /** Fetch a Turso API path. Cleanup deletes pass `interruptible: false`
   * so an aborted signal never prevents removal of an incomplete destination. */
  const fetchApi = (
    path: string,
    init: ApiRequestInit = {},
    interruptible = true,
  ): Promise<FetchResult> =>
    client.raw(path, {
      ...init,
      ...(interruptible && signal !== undefined ? { signal } : {}),
    });

  const deleteDatabase = async (
    organization: string,
    name: string,
  ): Promise<Result<void>> => {
    const response = await fetchApi(
      databasePath(organization, tursoDatabaseSlug(name)),
      { method: "DELETE" },
      false,
    );
    return response.ok
      ? okResult(undefined)
      : parseApiError(response, "Delete database");
  };

  const cleanUpFailedCreate = async (
    organization: string,
    name: string,
    failure: string,
  ): Promise<Result<never>> => {
    try {
      const cleanup = await deleteDatabase(organization, name);
      return cleanup.ok
        ? errorResult(failure)
        : errorResult(`${failure}. Cleanup also failed: ${cleanup.error}`);
    } catch (error) {
      return errorResult(
        `${failure}. Cleanup also failed: ${errorMessage(error)}`,
      );
    }
  };

  const postCreateRequest = (
    request: CreateTursoDatabaseRequest,
    name: string,
  ): Promise<FetchResult> =>
    fetchApi(databasePath(request.organization), {
      body: JSON.stringify({
        group: request.group,
        name,
        ...(request.seed ? { seed: { type: request.seed } } : {}),
      }),
      method: "POST",
    });

  /** Fetch one Turso list and answer its entries, or report the refusal. */
  const readList = async <Output, Entry>(
    path: string,
    schema: v.GenericSchema<unknown, Output>,
    label: string,
    entriesOf: (output: Output) => Entry[],
  ): Promise<Result<Entry[]>> => {
    const response = await fetchApi(path);
    return response.ok
      ? okResult(entriesOf(parseResponse(schema, response.text, label)))
      : parseApiError(response, label);
  };

  /** Ask the platform for one new full-access token for a database. */
  const generateToken: DatabaseTokenFn = async (organization, name) => {
    try {
      const tokenResponse = await fetchApi(
        `${databasePath(organization, name)}/auth/tokens?authorization=full-access`,
        { method: "POST" },
      );
      if (!tokenResponse.ok) {
        return parseApiError(tokenResponse, "Generate database token");
      }
      const { jwt } = parseResponse(
        TursoTokenSchema,
        tokenResponse.text,
        "Generate database token",
      );
      return okResult(jwt);
    } catch (error) {
      return errorResult(
        `Generate database token failed: ${errorMessage(error)}`,
      );
    }
  };

  const createDatabase = async (
    request: CreateTursoDatabaseRequest,
  ): Promise<Result<TursoDatabaseCredentials>> => {
    const name = tursoDatabaseSlug(request.name);
    let createResponse: FetchResult;
    try {
      createResponse = await postCreateRequest(request, name);
    } catch (error) {
      return errorResult(`Create database failed: ${errorMessage(error)}`);
    }
    if (!createResponse.ok)
      return parseApiError(createResponse, "Create database");
    let database: v.InferOutput<typeof TursoDatabaseSchema>;
    try {
      database = parseResponse(
        CreateTursoDatabaseSchema,
        createResponse.text,
        "Create database",
      ).database;
    } catch (error) {
      return await cleanUpFailedCreate(
        request.organization,
        name,
        `Create database failed: ${errorMessage(error)}`,
      );
    }
    if (database.Name !== name) {
      return errorResult(
        `Create database returned an unexpected name: ${database.Name}`,
      );
    }
    const dbUrl = `libsql://${database.Hostname}`;
    const token = await generateToken(request.organization, name);
    if (!token.ok) {
      return await cleanUpFailedCreate(request.organization, name, token.error);
    }
    return okResult({
      dbId: database.DbId,
      dbToken: token.value,
      dbUrl,
      name,
    });
  };

  return {
    createDatabase,
    databaseExists: async (organization, name) => {
      const response = await fetchApi(
        databasePath(organization, tursoDatabaseSlug(name)),
      );
      if (response.ok) return okResult(true);
      if (response.status === 404) return okResult(false);
      return parseApiError(response, "Check database");
    },
    deleteDatabase,
    listDatabases: (organization) =>
      readList(
        databasePath(organization),
        TursoDatabaseListSchema,
        "List Turso databases",
        ({ databases }) =>
          databases.map((database) => ({
            host: database.Hostname,
            id: database.Name,
          })),
      ),
    listGroups: (organization) =>
      readList(
        `/v1/organizations/${encodeURIComponent(organization)}/groups`,
        TursoGroupsSchema,
        "List Turso groups",
        ({ groups }) => namesFrom(groups, (group) => group.name),
      ),
    listOrganizations: () =>
      readList(
        "/v1/organizations",
        TursoOrganizationsSchema,
        "List Turso organizations",
        (organizations) =>
          namesFrom(organizations, (organization) => organization.slug),
      ),
    rotateDatabaseKey: async (organization, name) => {
      const rotated = await fetchApi(
        `${databasePath(organization, name)}/auth/rotate`,
        { method: "POST" },
      );
      if (!rotated.ok) return parseApiError(rotated, "Rotate database key");
      return generateToken(organization, name);
    },
  };
};

const createDatabaseImpl: CreateDatabaseFn = (name) =>
  createTursoApi(getTursoApiToken()).createDatabase({
    group: getTursoGroup(),
    name,
    organization: getTursoOrganization(),
  });

const rotateDatabaseKeyImpl: RotateDatabaseKeyFn = async (dbUrl) => {
  const organization = getTursoOrganization();
  const api = createTursoApi(getTursoApiToken());
  const database = requireListedDatabase(
    await api.listDatabases(organization),
    dbUrl,
    "Turso",
  );
  if (!database.ok) return database;
  return api.rotateDatabaseKey(organization, database.value.id);
};

export const tursoDbProvider: DatabaseProviderApi = {
  createDatabase: createDatabaseImpl,
  rotateDatabaseKey: rotateDatabaseKeyImpl,
};
