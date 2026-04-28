import { setEncryptionKeyForTest } from "#lib/crypto/encryption.ts";
import { setFastPbkdf2ForTest } from "#lib/crypto/hashing.ts";
import { setRsaKeySizeForTest } from "#lib/crypto/keys.ts";
import { setSuppressDebugLogs, setSuppressRequestLogs } from "#lib/logger.ts";
import { setRethrowErrors, setSkipLoginDelay } from "#lib/test-overrides.ts";
import { TEST_ENCRYPTION_KEY } from "#test-utils/internal.ts";

export const setupTestEncryptionKey = (): void => {
  setEncryptionKeyForTest(TEST_ENCRYPTION_KEY);
  setFastPbkdf2ForTest(true);
  setSkipLoginDelay(true);
  setRsaKeySizeForTest(1024);
  setSuppressRequestLogs(true);
  setSuppressDebugLogs(true);
  setRethrowErrors(true);
};

export const clearTestEncryptionKey = (): void => {
  setEncryptionKeyForTest("");
  setFastPbkdf2ForTest(null);
  setSkipLoginDelay(false);
  setRsaKeySizeForTest(null);
  setSuppressRequestLogs(null);
  setSuppressDebugLogs(null);
  setRethrowErrors(null);
};

const _realGet = Deno.env.get.bind(Deno.env);
const _realSet = Deno.env.set.bind(Deno.env);
const _realDelete = Deno.env.delete.bind(Deno.env);

let _overlay: Record<string, string | undefined> | null = null;

Deno.env.get = (key: string): string | undefined =>
  _overlay && key in _overlay ? _overlay[key] : _realGet(key);

Deno.env.set = (key: string, value: string): void => {
  if (_overlay && key in _overlay) _overlay[key] = value;
  else _realSet(key, value);
};

Deno.env.delete = (key: string): void => {
  if (_overlay && key in _overlay) _overlay[key] = undefined;
  else _realDelete(key);
};

export const setTestEnv = (
  vars: Record<string, string | undefined>,
): (() => void) => {
  const prev = _overlay;
  const layer: Record<string, string | undefined> = prev
    ? { ...prev }
    : Object.create(null);
  for (const key of Object.keys(vars)) {
    if (!(key in layer)) layer[key] = _realGet(key);
  }
  _overlay = layer;
  for (const key of Object.keys(vars)) {
    const value = vars[key];
    if (value !== undefined) Deno.env.set(key, value);
    else Deno.env.delete(key);
  }
  return () => {
    _overlay = prev;
  };
};
