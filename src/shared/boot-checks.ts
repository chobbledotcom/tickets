/**
 * Fail-fast validation for environment/configuration that must be sane before
 * the app starts accepting requests. Keep checks here when they are global
 * boot invariants rather than per-request validation concerns.
 */

import { validateEncryptionKey } from "#shared/crypto/encryption.ts";
import { getEnv } from "#shared/env.ts";

export type BootCheck = {
  name: string;
  run: () => void;
};

const MAIN_INSTANCE_KEY_MIN_BYTES = 32;

const encodedLength = (value: string): number =>
  new TextEncoder().encode(value).length;

export const validateOptionalMainInstanceKey = (): void => {
  const key = getEnv("MAIN_INSTANCE_KEY");
  if (key === undefined) return;
  if (key.trim().length === 0) {
    throw new Error(
      "MAIN_INSTANCE_KEY must be blank/unset or at least 32 bytes",
    );
  }
  const byteLength = encodedLength(key);
  if (byteLength < MAIN_INSTANCE_KEY_MIN_BYTES) {
    throw new Error(
      `MAIN_INSTANCE_KEY must be at least 32 bytes when set, got ${byteLength} bytes`,
    );
  }
};

export const BOOT_CHECKS: readonly BootCheck[] = [
  { name: "DB_ENCRYPTION_KEY", run: validateEncryptionKey },
  { name: "MAIN_INSTANCE_KEY", run: validateOptionalMainInstanceKey },
];

export const validateBootChecks = (): void => {
  validateEncryptionKey();
  validateOptionalMainInstanceKey();
};
