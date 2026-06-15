import { lazyRef } from "#fp";
import { setEncryptionKeyForTest } from "#shared/crypto/encryption.ts";
import { setFastPbkdf2ForTest } from "#shared/crypto/hashing.ts";
import { setRsaKeySizeForTest } from "#shared/crypto/keys.ts";
import {
  setSuppressDebugLogs,
  setSuppressRequestLogs,
} from "#shared/logger.ts";
import { setRethrowErrors, setSkipLoginDelay } from "#shared/test-overrides.ts";
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

// Overlay of test-scoped env vars, layered/restored by setTestEnv. lazyRef
// gives a resettable cell (set(null) clears it) without module-level `let`.
const [getOverlay, setOverlay] = lazyRef<Record<
  string,
  string | undefined
> | null>(() => null);

Deno.env.get = (key: string): string | undefined => {
  const overlay = getOverlay();
  return overlay && key in overlay ? overlay[key] : _realGet(key);
};

Deno.env.set = (key: string, value: string): void => {
  const overlay = getOverlay();
  if (overlay && key in overlay) overlay[key] = value;
  else _realSet(key, value);
};

Deno.env.delete = (key: string): void => {
  const overlay = getOverlay();
  if (overlay && key in overlay) overlay[key] = undefined;
  else _realDelete(key);
};

export const setTestEnv = (
  vars: Record<string, string | undefined>,
): (() => void) => {
  const prev = getOverlay();
  const layer: Record<string, string | undefined> = prev
    ? { ...prev }
    : Object.create(null);
  for (const key of Object.keys(vars)) {
    if (!(key in layer)) layer[key] = _realGet(key);
  }
  setOverlay(layer);
  for (const key of Object.keys(vars)) {
    const value = vars[key];
    if (value !== undefined) Deno.env.set(key, value);
    else Deno.env.delete(key);
  }
  return () => {
    setOverlay(prev);
  };
};
