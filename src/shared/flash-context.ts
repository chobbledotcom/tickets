/**
 * Per-request flash message context via AsyncLocalStorage.
 * Populated automatically by middleware from the flash cookie.
 * Consumed by templates via getFlash() — no manual reading needed in handlers.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Flash message shape — fields are only present when a message exists */
export type Flash = {
  success?: string;
  error?: string;
  info?: string;
  result?: string;
};

const flashStore = new AsyncLocalStorage<Flash>();

/** Run a function within a flash context scope */
export const runWithFlashContext = <T>(fn: () => T): T =>
  flashStore.run({}, fn);

/** Set the flash context for the current request (called by middleware) */
export const setFlashContext = (flash: Flash): void => {
  const store = flashStore.getStore();
  if (store) {
    store.success = flash.success;
    store.error = flash.error;
    store.info = flash.info;
    store.result = flash.result;
  }
};

/** Get the current flash message (for use in templates/handlers) */
export const getFlash = (): Flash => {
  const store = flashStore.getStore();
  return {
    error: store?.error,
    info: store?.info,
    result: store?.result,
    success: store?.success,
  };
};

/** Whether the current request has a flash message */
export const hasFlash = (): boolean => {
  const store = flashStore.getStore();
  return (
    store?.success !== undefined ||
    store?.error !== undefined ||
    store?.info !== undefined
  );
};
