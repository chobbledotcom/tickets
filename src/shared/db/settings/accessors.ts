/**
 * Generated string accessor pairs (sync getter + async writer) and the
 * typed update factories they share.
 *
 * One registry entry creates both the sync getter (`settings.<name>`) and,
 * unless readOnly, the matching writer (`settings.update.<name>`). Whether the
 * writer encrypts is derived from the same registry entry's storage mode.
 *
 * `rawUpdate` / `boolUpdate` / `timestampUpdate` back the hand-written
 * non-string writers (booleans, raw strings, last-modified timestamps).
 */

import {
  encryptedUpdate,
  plaintextUpdate,
  writeRaw,
} from "#shared/db/settings/raw-writes.ts";
import {
  type BoolSettingKey,
  type SettingsData,
  setSnapshotField,
  snap,
} from "#shared/db/settings/snapshot.ts";
import type {
  AccessorSpec,
  StringAccessors,
} from "#shared/settings/registry.ts";
import {
  ENCRYPTED_KEYS,
  PLAINTEXT_KEYS,
  STRING_ACCESSORS,
} from "#shared/settings/registry.ts";

/** Sync getter per accessor entry, typed by the underlying snapshot field so
 * sealed settings (e.g. the bulk-email draft) keep their brand. */
type GeneratedGetters = {
  readonly [K in keyof StringAccessors]: SettingsData[StringAccessors[K]["key"]];
};

/** Writable accessor names (entries without readOnly). */
type WritableAccessor = {
  [K in keyof StringAccessors]: StringAccessors[K] extends { readOnly: true }
    ? never
    : K;
}[keyof StringAccessors];

/** Async writer per writable accessor entry, typed like its getter so a sealed
 * setting can only be written with a correctly-sealed value. */
type GeneratedUpdaters = {
  [K in WritableAccessor]: (
    v: SettingsData[StringAccessors[K]["key"]],
  ) => Promise<void>;
};

const ENCRYPTED_KEY_SET: ReadonlySet<string> = new Set(ENCRYPTED_KEYS);

export { ENCRYPTED_KEY_SET };

/** Plaintext keys as a Set for fast membership checks during snapshot apply. */
export const PLAINTEXT_KEY_SET: ReadonlySet<string> = new Set(PLAINTEXT_KEYS);

/** Build the generated getters and updaters in one pass over the registry. */
const buildStringAccessors = (): {
  getters: GeneratedGetters;
  updaters: GeneratedUpdaters;
} => {
  const getters = {};
  const updaters: Record<string, (v: string) => Promise<void>> = {};
  for (const [name, spec] of Object.entries<AccessorSpec>(STRING_ACCESSORS)) {
    Object.defineProperty(getters, name, {
      enumerable: true,
      get: () => snap(spec.key),
    });
    if ("readOnly" in spec && spec.readOnly) continue;
    const update = ENCRYPTED_KEY_SET.has(spec.key)
      ? encryptedUpdate
      : plaintextUpdate;
    updaters[name] = update(spec.key);
  }
  return {
    getters: getters as GeneratedGetters,
    updaters: updaters as GeneratedUpdaters,
  };
};

/** Built accessor pairs: getters to spread onto the namespace, writers to
 *  spread onto `settings.update`. */
export const stringAccessors = buildStringAccessors();

/**
 * Factory: write a raw string and mirror into a specific snapshot field.
 * `serialize` defaults to `String` so a boolean or timestamp writer is just a
 * rawUpdate that knows how to render its value.
 */
export const rawUpdate =
  <K extends keyof SettingsData>(
    configKey: string,
    field: K,
    serialize: (v: SettingsData[K]) => string = String,
  ) =>
  async (v: SettingsData[K]): Promise<void> => {
    await writeRaw(configKey, serialize(v));
    setSnapshotField(field, v);
  };

/** Factory: write a boolean as "true"/"false" and mirror into the snapshot. */
export const boolUpdate = <K extends BoolSettingKey>(
  configKey: string,
  field: K,
) => rawUpdate(configKey, field, (v) => (v ? "true" : "false"));

/** Factory: write the current ISO timestamp to a config key and mirror into the
 *  snapshot (a "last modified at" writer). */
export const timestampUpdate =
  <K extends keyof SettingsData>(configKey: string, field: K) =>
  async (): Promise<void> => {
    const ts = new Date().toISOString();
    await writeRaw(configKey, ts);
    setSnapshotField(field, ts as SettingsData[K]);
  };
