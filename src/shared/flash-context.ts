/**
 * Per-request flash message context via AsyncLocalStorage.
 * Populated automatically by middleware from the flash cookie.
 * Consumed by templates via getFlash() — no manual reading needed in handlers.
 */

import {
  currentRequestStore,
  type RequestSlot,
  requestSlot,
} from "#shared/request-context.ts";

/** Flash message shape — fields are only present when a message exists */
export type Flash = {
  success?: string | undefined;
  error?: string | undefined;
  info?: string | undefined;
  result?: string | undefined;
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
export type FlashStore = Flash & { formId?: string; consumed?: boolean };

const FLASH_SLOT: RequestSlot<FlashStore> = {
  fresh: () => ({}),
  read: (store) => store.flash,
  write: (store, state) => {
    store.flash = state;
  },
};

const flashStore = (): FlashStore | undefined => requestSlot(FLASH_SLOT);

/** Record which form a redirect targeted, so the matching CsrfForm renders the
 *  flash inline rather than the Layout rendering it at the top of the page. */
export const setFlashFormId = (formId: string | null): void => {
  const slot = flashStore();
  if (slot && formId) slot.formId = formId;
};

/** The form a redirect targeted, or undefined when the flash isn't form-scoped. */
export const getFlashFormId = (): string | undefined =>
  currentRequestStore()?.flash?.formId;

/** Mark the flash as rendered, so the Layout backstop won't render it again. */
export const consumeFlash = (): void => {
  const slot = flashStore();
  if (slot) slot.consumed = true;
};

/** Whether the flash has already been rendered this request. */
export const flashConsumed = (): boolean =>
  currentRequestStore()?.flash?.consumed === true;

/** Set the flash context for the current request (called by middleware).
 *  Throws outside a request scope: a silent drop hides the buyer's
 *  message. */
export const setFlashContext = (flash: Flash): void => {
  const slot = flashStore();
  if (slot === undefined) {
    throw new Error("setFlashContext ran outside a request scope");
  }
  slot.success = flash.success;
  slot.error = flash.error;
  slot.info = flash.info;
  slot.result = flash.result;
};

/** Get the current flash message (for use in templates/handlers) */
export const getFlash = (): Flash => {
  const store = currentRequestStore()?.flash;
  return {
    error: store?.error,
    info: store?.info,
    result: store?.result,
    success: store?.success,
  };
};

/** Whether the current request has a flash message */
export const hasFlash = (): boolean => {
  const store = currentRequestStore()?.flash;
  return (
    store?.success !== undefined ||
    store?.error !== undefined ||
    store?.info !== undefined
  );
};
