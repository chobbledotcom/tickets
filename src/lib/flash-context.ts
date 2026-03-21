/**
 * Per-request flash message context.
 * Populated automatically by middleware from the flash cookie.
 * Consumed by templates via getFlash() — no manual reading needed in handlers.
 */

/** The current request's flash message, set by middleware before rendering */
const _flash = { success: "", error: "" };

/** Set the flash context for the current request (called by middleware) */
export const setFlashContext = (success: string, error: string): void => {
  _flash.success = success;
  _flash.error = error;
};

/** Reset the flash context (called by middleware after response) */
export const resetFlashContext = (): void => {
  _flash.success = "";
  _flash.error = "";
};

/** Get the current flash success message (for use in templates/handlers) */
export const getFlash = (): { success: string; error: string } => ({
  success: _flash.success,
  error: _flash.error,
});

/** Whether the current request has a flash message */
export const hasFlash = (): boolean =>
  _flash.success !== "" || _flash.error !== "";
