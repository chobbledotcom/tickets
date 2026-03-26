/**
 * Per-request flash message context.
 * Populated automatically by middleware from the flash cookie.
 * Consumed by templates via getFlash() — no manual reading needed in handlers.
 */

/** Flash message shape — fields are only present when a message exists */
export type Flash = { success?: string; error?: string; result?: string };

/** The current request's flash message, set by middleware before rendering */
const _flash: Flash = {};

/** Set the flash context for the current request (called by middleware) */
export const setFlashContext = (flash: Flash): void => {
  _flash.success = flash.success;
  _flash.error = flash.error;
  _flash.result = flash.result;
};

/** Reset the flash context (called by middleware after response) */
export const resetFlashContext = (): void => {
  _flash.success = undefined;
  _flash.error = undefined;
  _flash.result = undefined;
};

/** Get the current flash message (for use in templates/handlers) */
export const getFlash = (): Flash => ({
  success: _flash.success,
  error: _flash.error,
  result: _flash.result,
});

/** Whether the current request has a flash message */
export const hasFlash = (): boolean =>
  _flash.success !== undefined || _flash.error !== undefined;
