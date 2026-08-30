/** Turso platform API client used by site provisioning and database migration. */

/* jscpd:ignore-start */
import * as v from "valibot";
import {
  getTursoApiToken,
  getTursoGroup,
  getTursoOrganization,
  tursoDatabaseSlug,
} from "#shared/config.ts";
import { errorMessage } from "#shared/error-message.ts";
import {
  type FetchResult,
  fetchText,
  jsonHeaders,
  parseApiError,
} from "#shared/fetch.ts";
import type {
  CreateDatabaseFn,
  DatabaseCredentials,
  DatabaseProviderApi,
} from "#shared/provider-types.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/* jscpd:ignore-end */

const TURSO_API_BASE = "https://api.turso.tech";

const NonEmptyStringSchema = v.pipe(v.string(), v.nonEmpty());
const TursoHostnameSchema = v.pipe(
  NonEmptyStringSchema,
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
  DbId: NonEmptyStringSchema,
  Hostname: TursoHostnameSchema,
  Name: NonEmptyStringSchema,
});
const CreateTursoDatabaseSchema = v.object({ database: TursoDatabaseSchema });
const TursoTokenSchema = v.object({ jwt: NonEmptyStringSchema });
const TursoOrganizationsSchema = v.array(
  v.object({ slug: NonEmptyStringSchema }),
);
const TursoGroupsSchema = v.object({
  groups: v.array(v.object({ name: NonEmptyStringSchema })),
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

export interface TursoApi {
  createDatabase(
    request: CreateTursoDatabaseRequest,
  ): Promise<Result<TursoDatabaseCredentials>>;
  databaseExists(organization: string, name: string): Promise<Result<boolean>>;
  deleteDatabase(organization: string, name: string): Promise<Result<void>>;
  listGroups(organization: string): Promise<Result<string[]>>;
  listOrganizations(): Promise<Result<string[]>>;
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
 * cancels in-flight requests; cleanup deletes always ignore it so an
 * incomplete destination can still be removed after an interrupt. */
export const createTursoApi = (
  apiToken: string,
  signal?: AbortSignal,
): TursoApi => {
  const apiHeaders = (): Record<string, string> =>
    jsonHeaders({ Authorization: `Bearer ${apiToken}` });
  /** Fetch a Turso API path. Cleanup deletes pass `interruptible: false`
   * so an aborted signal never prevents removal of an incomplete destination. */
  const fetchApi = (
    path: string,
    init: RequestInit = {},
    interruptible = true,
  ): Promise<FetchResult> =>
    fetchText(`${TURSO_API_BASE}${path}`, {
      ...init,
      headers: apiHeaders(),
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
    try {
      const tokenResponse = await fetchApi(
        `${databasePath(request.organization, name)}/auth/tokens?authorization=full-access`,
        { method: "POST" },
      );
      if (!tokenResponse.ok) {
        const failure = parseApiError(tokenResponse, "Generate database token");
        return await cleanUpFailedCreate(
          request.organization,
          name,
          failure.error,
        );
      }
      const { jwt: dbToken } = parseResponse(
        TursoTokenSchema,
        tokenResponse.text,
        "Generate database token",
      );
      return okResult({
        dbId: database.DbId,
        dbToken,
        dbUrl,
        name,
      });
    } catch (error) {
      return await cleanUpFailedCreate(
        request.organization,
        name,
        `Generate database token failed: ${errorMessage(error)}`,
      );
    }
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
    listGroups: async (organization) => {
      const response = await fetchApi(
        `/v1/organizations/${encodeURIComponent(organization)}/groups`,
      );
      if (!response.ok) {
        return parseApiError(response, "List Turso groups");
      }
      const { groups } = parseResponse(
        TursoGroupsSchema,
        response.text,
        "List Turso groups",
      );
      return okResult(namesFrom(groups, (group) => group.name));
    },
    listOrganizations: async () => {
      const response = await fetchApi("/v1/organizations");
      if (!response.ok) {
        return parseApiError(response, "List Turso organizations");
      }
      const organizations = parseResponse(
        TursoOrganizationsSchema,
        response.text,
        "List Turso organizations",
      );
      return okResult(
        namesFrom(organizations, (organization) => organization.slug),
      );
    },
  };
};

const createDatabaseImpl: CreateDatabaseFn = (name) =>
  createTursoApi(getTursoApiToken()).createDatabase({
    group: getTursoGroup(),
    name,
    organization: getTursoOrganization(),
  });

export const tursoDbProvider: DatabaseProviderApi = {
  createDatabase: createDatabaseImpl,
};
