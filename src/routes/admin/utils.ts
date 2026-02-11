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

/** Verify identifier matches for confirmation (case-insensitive, trimmed) */
export const verifyIdentifier = (expected: string, provided: string): boolean =>
  expected.trim().toLowerCase() === provided.trim().toLowerCase();

/** Extract and validate ?date= query parameter. Returns null if absent or invalid. */
export const getDateFilter = (request: Request): string | null => {
  const date = new URL(request.url).searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date;
};

/** Build a CSV file download response */
export const csvResponse = (csv: string, filename: string): Response =>
  new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
