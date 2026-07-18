import {
  fromBase64Url,
  generateSecureToken,
  toBase64Url,
} from "#shared/crypto/utils.ts";
import { getEnv } from "#shared/env.ts";

export const SCHEDULED_TASK_KEY_ENV = "SCHEDULED_TASK_KEY";
export const SCHEDULED_TASK_KEY_NEXT_ENV = "SCHEDULED_TASK_KEY_NEXT";
export const SCHEDULED_KEY_BYTES = 32;

export const generateScheduledTaskKey = (): string => generateSecureToken();

export const isScheduledTaskKey = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = fromBase64Url(value);
  return bytes.length === SCHEDULED_KEY_BYTES && toBase64Url(bytes) === value;
};

const validateSlot = (name: string, value: string | undefined): void => {
  if (value === undefined) return;
  if (!isScheduledTaskKey(value)) {
    throw new Error(
      `${name} must be canonical unpadded base64url for exactly ${SCHEDULED_KEY_BYTES} bytes`,
    );
  }
};

export const validateScheduledTaskKeys = (): void => {
  const active = getEnv(SCHEDULED_TASK_KEY_ENV);
  const next = getEnv(SCHEDULED_TASK_KEY_NEXT_ENV);
  validateSlot(SCHEDULED_TASK_KEY_ENV, active);
  validateSlot(SCHEDULED_TASK_KEY_NEXT_ENV, next);
  if (active === undefined && next !== undefined) {
    throw new Error(
      `${SCHEDULED_TASK_KEY_NEXT_ENV} requires ${SCHEDULED_TASK_KEY_ENV}`,
    );
  }
  if (active !== undefined && active === next) {
    throw new Error("Scheduled task keys must be different");
  }
};
