/**
 * The Bunny calls a preview site needs, on the staging account. Each call
 * checks the answer against a strict schema, so a changed answer fails in the
 * job log instead of passing on a guess. Code upload and publish reuse the
 * deploy script's calls.
 */

import * as v from "valibot";
import {
  bunnyRequest,
  deployScriptCode,
  formatBunnyError,
} from "#scripts/deploy-edge-lib.ts";
import type { FetchText } from "#scripts/fetch-text.ts";
import { parseAnswer } from "#scripts/preview/answers.ts";
import { mapped } from "#scripts/preview/steps.ts";
import { databasePageSchema, edgeScriptSchema } from "#shared/bunny-answers.ts";
import { databaseTokenFromResponse } from "#shared/provider-types.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

export type BunnyIo = { accessKey: string; fetchText: FetchText };

export type ScriptRef = { id: number; name: string };
export type ScriptDetails = { defaultHostname: string; pullZoneId: number };
export type DatabaseRef = { id: string; name: string };

const SCRIPTS_PER_PAGE = 100;
const DATABASES_PER_PAGE = 50;
/** The storage region Bunny's database API needs. The site builder uses the
 * same value. */
const STORAGE_REGION = "eu-west-1";

const ScriptListSchema = v.object({
  HasMoreItems: v.boolean(),
  Items: v.array(v.object({ Id: v.number(), Name: v.string() })),
});

const CreatedScriptSchema = v.object({
  ...edgeScriptSchema.entries,
  Id: v.number(),
});

const SecretListSchema = v.object({
  Secrets: v.nullable(v.array(v.object({ Name: v.string() }))),
});

const DatabaseListSchema = databasePageSchema({ name: v.string() });

const DatabaseSchema = v.object({ db: v.object({ url: v.string() }) });
const CreatedDatabaseSchema = v.object({ db_id: v.string() });
const DatabaseConfigSchema = v.object({
  primary_regions: v.array(v.object({ id: v.string() })),
});

/** The JSON text of a request body, or nothing for a call with no body. */
const bodyText = (body: unknown): string | undefined =>
  body === undefined ? undefined : JSON.stringify(body);

/** One request whose JSON answer must match a schema. */
const read = async <T>(
  io: BunnyIo,
  label: string,
  method: string,
  path: string,
  schema: v.GenericSchema<unknown, T>,
  body?: unknown,
): Promise<Result<T>> => {
  const response = await bunnyRequest(io, path, method, bodyText(body));
  return parseAnswer(response, label, schema);
};

/** One request whose answer carries nothing to read. A missing thing counts
 * as done when the caller says so: a delete of a gone thing is a success. */
const act = async (
  io: BunnyIo,
  label: string,
  method: string,
  path: string,
  options: { body?: unknown; missingIsDone?: boolean } = {},
): Promise<Result<void>> => {
  const response = await bunnyRequest(io, path, method, bodyText(options.body));
  const done =
    response.ok || (options.missingIsDone === true && response.status === 404);
  return done
    ? okResult(undefined)
    : errorResult(formatBunnyError(label, response));
};

/** A delete. A thing that is already gone counts as deleted. */
const remove = (io: BunnyIo, label: string, path: string) =>
  act(io, label, "DELETE", path, { missingIsDone: true });

/** One page of a list, as the walk below needs it. */
type Page<Item> = { hasMore: boolean; items: Item[] };

/** Every item of a paged list, one page after another. */
const listPaged = async <Answer, Item>(
  io: BunnyIo,
  label: string,
  pagePath: (page: number) => string,
  schema: v.GenericSchema<unknown, Answer>,
  toPage: (answer: Answer) => Page<Item>,
  page = 1,
  earlier: Item[] = [],
): Promise<Result<Item[]>> => {
  const fetched = mapped(
    await read(io, label, "GET", pagePath(page), schema),
    toPage,
  );
  if (!fetched.ok) return fetched;
  const found = [...earlier, ...fetched.value.items];
  return fetched.value.hasMore
    ? listPaged(io, label, pagePath, schema, toPage, page + 1, found)
    : okResult(found);
};

/** The item with this name, or null. No item is a normal answer: a preview
 * that was not made yet has none. */
const namedOrNull = async <Item extends { name: string }>(
  items: Promise<Result<Item[]>>,
  name: string,
): Promise<Result<Item | null>> => {
  const listed = await items;
  return listed.ok
    ? okResult(listed.value.find((item) => item.name === name) ?? null)
    : listed;
};

const listScripts = (io: BunnyIo): Promise<Result<ScriptRef[]>> =>
  listPaged(
    io,
    "List scripts",
    (page) => `/compute/script?page=${page}&perPage=${SCRIPTS_PER_PAGE}`,
    ScriptListSchema,
    (answer) => ({
      hasMore: answer.HasMoreItems,
      items: answer.Items.map(({ Id, Name }) => ({ id: Id, name: Name })),
    }),
  );

const listDatabases = (io: BunnyIo): Promise<Result<DatabaseRef[]>> =>
  listPaged(
    io,
    "List databases",
    (page) =>
      `/database/v2/databases?page=${page}&per_page=${DATABASES_PER_PAGE}`,
    DatabaseListSchema,
    (answer) => ({
      hasMore: answer.page_info.has_more_items,
      items: answer.databases,
    }),
  );

/** The hostname and linked pull zone of a script. A script without either
 * breaks what the create call promised, so the read fails. */
const scriptDetails = (
  script: v.InferOutput<typeof edgeScriptSchema>,
  label: string,
): Result<ScriptDetails> => {
  const [pullZone] = script.LinkedPullZones;
  return pullZone === undefined || script.DefaultHostname === ""
    ? errorResult(`${label} gave a script with no hostname or pull zone.`)
    : okResult({
        defaultHostname: script.DefaultHostname,
        pullZoneId: pullZone.Id,
      });
};

const getScript = async (
  io: BunnyIo,
  id: number,
): Promise<Result<ScriptDetails>> => {
  const script = await read(
    io,
    "Get script",
    "GET",
    `/compute/script/${id}`,
    edgeScriptSchema,
  );
  return script.ok ? scriptDetails(script.value, "Get script") : script;
};

const createScript = async (
  io: BunnyIo,
  name: string,
  code: string,
): Promise<Result<ScriptDetails & { id: number }>> => {
  const created = await read(
    io,
    "Create script",
    "POST",
    "/compute/script",
    CreatedScriptSchema,
    { Code: code, CreateLinkedPullZone: true, Name: name, ScriptType: 1 },
  );
  if (!created.ok) return created;
  const details = scriptDetails(created.value, "Create script");
  return details.ok
    ? okResult({ ...details.value, id: created.value.Id })
    : details;
};

const listSecretNames = async (
  io: BunnyIo,
  id: number,
): Promise<Result<string[]>> =>
  mapped(
    await read(
      io,
      "List secrets",
      "GET",
      `/compute/script/${id}/secrets`,
      SecretListSchema,
    ),
    (answer) => (answer.Secrets ?? []).map((secret) => secret.Name),
  );

const deployCode = async (
  io: BunnyIo,
  id: number,
  code: string,
): Promise<Result<void>> => {
  const deployed = await deployScriptCode(
    String(id),
    code,
    io.accessKey,
    io.fetchText,
  );
  return deployed.ok ? okResult(undefined) : errorResult(deployed.error);
};

/** A new database in one region, with no replicas. A preview holds test data
 * only, so it does not need the all-region setup that a client site has. */
const createDatabase = async (
  io: BunnyIo,
  name: string,
): Promise<Result<string>> => {
  const config = await read(
    io,
    "Get database config",
    "GET",
    "/database/v1/config",
    DatabaseConfigSchema,
  );
  if (!config.ok) return config;
  const [region] = config.value.primary_regions;
  if (region === undefined) {
    return errorResult("Get database config listed no primary region.");
  }
  return mapped(
    await read(
      io,
      "Create database",
      "POST",
      "/database/v2/databases",
      CreatedDatabaseSchema,
      {
        name,
        primary_regions: [region.id],
        replicas_regions: [],
        storage_region: STORAGE_REGION,
      },
    ),
    (answer) => answer.db_id,
  );
};

const databaseUrl = async (io: BunnyIo, id: string): Promise<Result<string>> =>
  mapped(
    await read(
      io,
      "Get database",
      "GET",
      `/database/v2/databases/${encodeURIComponent(id)}`,
      DatabaseSchema,
    ),
    (answer) => answer.db.url,
  );

/** One new full-access token. A reply with no token throws. */
const issueDatabaseToken = async (
  io: BunnyIo,
  id: string,
): Promise<Result<string>> => {
  const response = await bunnyRequest(
    io,
    `/database/v2/databases/${encodeURIComponent(id)}/auth/generate`,
    "PUT",
    JSON.stringify({ authorization: "full-access", expires_at: null }),
  );
  return response.ok
    ? okResult(databaseTokenFromResponse(response.text, "token"))
    : errorResult(formatBunnyError("Generate database token", response));
};

/** The preview calls, bound to one account key and one fetch. */
export const previewApi = (io: BunnyIo) => ({
  allowCookies: (pullZoneId: number) =>
    act(io, "Allow pull zone cookies", "POST", `/pullzone/${pullZoneId}`, {
      body: { DisableCookies: false },
    }),
  createDatabase: (name: string) => createDatabase(io, name),
  createScript: (name: string, code: string) => createScript(io, name, code),
  databaseNamedOrNull: (name: string) => namedOrNull(listDatabases(io), name),
  databaseUrl: (id: string) => databaseUrl(io, id),
  deleteDatabase: (id: string) =>
    remove(io, "Delete database", `/database/v2/databases/${id}`),
  deletePullZone: (id: number) =>
    remove(io, "Delete pull zone", `/pullzone/${id}`),
  deleteScript: (id: number) =>
    remove(io, "Delete script", `/compute/script/${id}`),
  deployCode: (id: number, code: string) => deployCode(io, id, code),
  getScript: (id: number) => getScript(io, id),
  issueDatabaseToken: (id: string) => issueDatabaseToken(io, id),
  listSecretNames: (id: number) => listSecretNames(io, id),
  scriptNamedOrNull: (name: string) => namedOrNull(listScripts(io), name),
  setSecret: (id: number, name: string, value: string) =>
    act(io, `Set secret ${name}`, "PUT", `/compute/script/${id}/secrets`, {
      body: { Name: name, Secret: value },
    }),
});

export type PreviewApi = ReturnType<typeof previewApi>;
