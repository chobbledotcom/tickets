/**
 * Shared admin utilities and types
 */

import type { validateForm } from "#lib/forms.tsx";
import type { AuthSession } from "#routes/utils.ts";

/** Form field definition type */
export type FormFields = Parameters<typeof validateForm>[1];

/** Result of form validation with typed values */
export type ValidatedForm = ReturnType<typeof validateForm> & { valid: true };

/** Auth + form + validation result */
export type AuthValidationResult =
  | { ok: true; session: AuthSession; validation: ValidatedForm }
  | { ok: false; response: Response };

/** Cookie to clear admin session */
export const clearSessionCookie =
  "__Host-session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
