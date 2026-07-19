import {
  fromBase64Url,
  generateSecureToken,
  toBase64Url,
} from "#shared/crypto/utils.ts";
import { getEnv } from "#shared/env.ts";

export const SCHEDULED_TASK_KEY_ENV = "SCHEDULED_TASK_KEY";
export const SCHEDULED_KEY_BYTES = 32;

export const generateScheduledTaskKey = (): string => generateSecureToken();

export const isScheduledTaskKey = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = fromBase64Url(value);
  return bytes.length === SCHEDULED_KEY_BYTES && toBase64Url(bytes) === value;
};

const validateKey = (name: string, value: string | undefined): void => {
  if (value === undefined) return;
  if (!isScheduledTaskKey(value)) {
    throw new Error(
      `${name} must be canonical unpadded base64url for exactly ${SCHEDULED_KEY_BYTES} bytes`,
    );
  }
};

export const validateScheduledTaskKey = (): void =>
  validateKey(SCHEDULED_TASK_KEY_ENV, getEnv(SCHEDULED_TASK_KEY_ENV));
