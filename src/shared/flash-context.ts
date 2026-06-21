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
  /**
   * Redemption token for the in-memory form re-fill stash. Carried in the
   * flash cookie and consumed at the read seam; never stored in the flash
   * context itself.
   */
  formToken?: string;
};

/**
 * Internal store shape: the flash message plus two render-coordination fields.
 * `formId` is the form a redirect targeted (`?form=`), so a matching CsrfForm
 * renders the flash inline; `consumed` is set once any component has rendered
 * it, so the Layout backstop doesn't render it a second time.
 */
type FlashStore = Flash & { formId?: string; consumed?: boolean };

const flashStore = new AsyncLocalStorage<FlashStore>();

/** Run a function within a flash context scope */
export const runWithFlashContext = <T>(fn: () => T): T =>
  flashStore.run({}, fn);

/** Record which form a redirect targeted, so the matching CsrfForm renders the
 *  flash inline rather than the Layout rendering it at the top of the page. */
export const setFlashFormId = (formId: string | null): void => {
  const store = flashStore.getStore();
  if (store && formId) store.formId = formId;
};

/** The form a redirect targeted, or undefined when the flash isn't form-scoped. */
export const getFlashFormId = (): string | undefined =>
  flashStore.getStore()?.formId;

/** Mark the flash as rendered, so the Layout backstop won't render it again. */
export const consumeFlash = (): void => {
  const store = flashStore.getStore();
  if (store) store.consumed = true;
};

/** Whether the flash has already been rendered this request. */
export const flashConsumed = (): boolean =>
  flashStore.getStore()?.consumed === true;

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
