/**
 * Bring one branch's preview site to the state "created, with every secret,
 * code published". Each resource is found by name first, so a run that stopped
 * half way continues instead of making a second copy. A secret that already
 * exists is never written again: DB_ENCRYPTION_KEY must stay the same, or the
 * kept database cannot be read.
 */

import { once } from "#fp";
import type {
  DatabaseId,
  PreviewApi,
  ScriptDetails,
  ScriptId,
} from "#scripts/preview/bunny-api.ts";
import type { PreviewNames } from "#scripts/preview/names.ts";
import { andThen } from "#scripts/preview/steps.ts";
import { okResult, type Result } from "#shared/result.ts";
import { siteBaseUrl } from "#shared/site-address.ts";

export type EnsureInput = {
  /** The staging account key. The site keeps a copy, so that it can manage its
   * own CDN. */
  accessKey: string;
  code: string;
  /** Secrets that come from the build environment, as [name, value]. */
  copiedSecrets: readonly (readonly [string, string])[];
  names: PreviewNames;
  newEncryptionKey: () => string;
  newScheduledTaskKey: () => string;
};

export type EnsuredPreview = {
  /** True when this run uploaded and published the code. When false, the
   * caller must deploy the code. */
  published: boolean;
  scriptId: ScriptId;
  siteUrl: string;
};

type SecretSource = () => Promise<Result<string>>;

/** The preview's database: found by name, or made. */
const databaseId = (
  api: PreviewApi,
  name: string,
): Promise<Result<DatabaseId>> =>
  andThen(api.databaseNamedOrNull(name), async (found) =>
    found === null ? api.createDatabase(name) : okResult(found.id),
  );

const known =
  (value: string): SecretSource =>
  () =>
    Promise.resolve(okResult(value));

/** Every secret the site needs, with the step that makes its value. The
 * database steps run only for a missing database secret. */
const secretSources = (
  api: PreviewApi,
  input: EnsureInput,
  scriptId: ScriptId,
): [string, SecretSource][] => {
  const database = once(() => databaseId(api, input.names.databaseName));
  return [
    ["DB_URL", () => andThen(database(), (id) => api.databaseUrl(id))],
    ["DB_TOKEN", () => andThen(database(), (id) => api.issueDatabaseToken(id))],
    ["DB_ENCRYPTION_KEY", known(input.newEncryptionKey())],
    ["SCHEDULED_TASK_KEY", known(input.newScheduledTaskKey())],
    ["BUNNY_API_KEY", known(input.accessKey)],
    ["BUNNY_SCRIPT_ID", known(String(scriptId))],
    ...input.copiedSecrets.map(([name, value]): [string, SecretSource] => [
      name,
      known(value),
    ]),
  ];
};

/** The script of this branch: found by name, or created. */
const openScript = (
  api: PreviewApi,
  input: EnsureInput,
): Promise<Result<ScriptDetails & { id: ScriptId }>> =>
  andThen(api.scriptNamedOrNull(input.names.scriptName), async (found) =>
    found === null
      ? api.createScript(input.names.scriptName, input.code)
      : andThen(api.getScript(found.id), async (details) =>
          okResult({ ...details, id: found.id }),
        ),
  );

/** Write each missing secret, one after another, and stop at the first
 * failure. */
const writeSecrets = async (
  api: PreviewApi,
  scriptId: ScriptId,
  missing: [string, SecretSource][],
): Promise<Result<void>> => {
  for (const [name, source] of missing) {
    const value = await source();
    if (!value.ok) return value;
    const written = await api.setSecret(scriptId, name, value.value);
    if (!written.ok) return written;
  }
  return okResult(undefined);
};

export const ensurePreview = async (
  api: PreviewApi,
  input: EnsureInput,
): Promise<Result<EnsuredPreview>> => {
  const script = await openScript(api, input);
  if (!script.ok) return script;
  const { defaultHostname, id, pullZoneId } = script.value;
  const result = {
    scriptId: id,
    siteUrl: siteBaseUrl(defaultHostname),
  };

  const present = await api.listSecretNames(id);
  if (!present.ok) return present;
  const missing = secretSources(api, input, id).filter(
    ([name]) => !present.value.includes(name),
  );
  if (missing.length === 0) return okResult({ ...result, published: false });

  const cookies = await api.allowCookies(pullZoneId);
  if (!cookies.ok) return cookies;
  const written = await writeSecrets(api, id, missing);
  if (!written.ok) return written;
  const deployed = await api.deployCode(id, input.code);
  if (!deployed.ok) return deployed;
  return okResult({ ...result, published: true });
};
