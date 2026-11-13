/**
 * The API-key record: the row a page lists and deletes, and the create command
 * that wraps the session's data key under the new key. Its read and delete are
 * per user, so they take the request actor.
 */

import { unwrapSessionDataKey } from "#crypto/keys.ts";
import { generateSecureToken } from "#crypto/utils.ts";
import {
  createApiKey,
  deleteApiKey,
  findApiKeyForUser,
  getApiKeysForUser,
} from "#db/api-keys.ts";
import { t } from "#i18n";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import {
  defineRecord,
  type RecordActor,
  type RecordShapeOf,
  type WriteVerdict,
} from "#shared/rest/record.ts";
import { ruledCommand } from "#shared/rest/record-command.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** One API key as the page lists it. The secret is present only on a create
 * answer, where the page shows it once. */
export type ApiKeyDisplay = {
  created: string;
  id: number;
  lastUsed: string;
  name: string;
  secret?: string;
};

export type ApiKeyInput = { name: string };

const sessionOf = (actor?: RecordActor) => {
  if (actor === undefined) {
    throw new Error("An API key read requires the request session");
  }
  return actor.session;
};

/** The key one request can read: its id and the session's user. */
const apiKeyForActor = (id: number, actor?: RecordActor) =>
  findApiKeyForUser(id, sessionOf(actor).userId);

/** The one API-key rule: a name the page can accept. */
const apiKeyRule = (input: ApiKeyInput): Result<ApiKeyInput> => {
  const name = input.name.trim();
  if (name === "") return errorResult(t("error.name_required"));
  if (name.length > MAX_INPUT_LENGTH) {
    return errorResult(
      t("fields.validation.max_length", {
        label: t("common.name"),
        max: MAX_INPUT_LENGTH,
      }),
    );
  }
  return okResult({ name });
};

const createApiKeyCommand = async (
  input: ApiKeyInput,
  actor?: RecordActor,
): Promise<WriteVerdict<ApiKeyDisplay>> =>
  ruledCommand({
    input,
    rule: apiKeyRule,
    run: async (value) => {
      const session = sessionOf(actor);
      const dataKey = await unwrapSessionDataKey(session);
      const created = await createApiKey(
        session.userId,
        value.name,
        dataKey,
        generateSecureToken,
      );
      const row = (await getApiKeysForUser(session.userId)).find(
        (key) => key.id === created.id,
      );
      if (row === undefined) {
        throw new Error(`API key ${created.id} was created but not read back`);
      }
      return { kind: "written", row: { ...row, secret: created.apiKey } };
    },
    stored: null,
  });

export const apiKeyRecord = defineRecord<
  RecordShapeOf<ApiKeyDisplay, ApiKeyInput>
>({
  activityName: "API key",
  getAll: (actor) => getApiKeysForUser(sessionOf(actor).userId),
  load: async (id, actor) => {
    const key = await apiKeyForActor(id, actor);
    return key === null ? null : { ...key, created: "", lastUsed: "" };
  },
  logName: (input) => input.name,
  nameLabel: "api_keys.name_label",
  nameOf: (key) => key.name,
  rule: apiKeyRule,
  surface: { deleteDestination: "apiKeyDelete", list: "apiKeys" },
  write: {
    create: createApiKeyCommand,
    remove: async (id, _input, actor) => {
      const key = await apiKeyForActor(id, actor);
      if (key === null) return { kind: "not-found" };
      return (await deleteApiKey(id, sessionOf(actor).userId))
        ? { kind: "deleted" }
        : { kind: "not-found" };
    },
    update: async (id, _input, actor) =>
      (await apiKeyForActor(id, actor)) === null
        ? { kind: "not-found" }
        : { kind: "refused", message: "An API key cannot be renamed" },
  },
});
