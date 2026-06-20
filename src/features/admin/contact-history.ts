/**
 * Editor for a single contact_preferences record, keyed by its HMAC blind
 * index (contact_hash). The attendee page's contact-history panel links here so
 * the operator can inspect and repair a contact's aggregated booking/message
 * counts and owner-encrypted private note directly.
 *
 *   GET  /admin/history/:hmac — render the record editor
 *   POST /admin/history/:hmac — save the edited record
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { requirePrivateKey } from "#routes/admin/actions.ts";
import { AUTH_FORM, requireSessionOr, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  type ContactRecord,
  fromContactHashParam,
  getContactCountFields,
  getContactRecord,
  saveContactRecord,
  toContactHashParam,
} from "#shared/db/contact-preferences.ts";
import type { FormParams } from "#shared/form-data.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { contactHistoryPage } from "#templates/admin/contact-history.tsx";

/* jscpd:ignore-end */

/** Load the record for the editor, tolerating a corrupt stats blob. This editor
 * is the repair path, so a decryption failure must not lock the operator out:
 * keep the plaintext counts (read separately) and blank the unreadable note, so
 * the rendered form lets a save overwrite the bad ciphertext without losing the
 * real booking history. */
const loadForRepair = async (
  hash: string,
  privateKey: CryptoKey,
): Promise<ContactRecord> => {
  try {
    return await getContactRecord(hash, privateKey);
  } catch (error) {
    logError({
      code: ErrorCode.DECRYPT_FAILED,
      detail: `contact history editor ${toContactHashParam(hash)}: ${error}`,
    });
    return {
      ...(await getContactCountFields(hash)),
      adminNotes: "",
      contactCount: 0,
      lastContact: "",
      lastSubject: "",
    };
  }
};

/** Read one editable counter as a non-negative integer (blank/garbage → 0). */
const nonNegativeInt = (form: FormParams, field: string): number =>
  Math.max(0, form.getOptionalInt(field) ?? 0);

/** Build the record to save from the submitted form. The last-contacted
 * timestamp is preserved from the loaded record — it is shown read-only and is
 * not an operator-editable field. */
const recordFromForm = (
  form: FormParams,
  current: ContactRecord,
): ContactRecord => ({
  adminBookingCount: nonNegativeInt(form, "admin_booking_count"),
  adminNotes: form.getString("admin_notes"),
  contactCount: nonNegativeInt(form, "messages"),
  lastContact: current.lastContact,
  lastSubject: form.getString("last_subject"),
  publicBookingCount: nonNegativeInt(form, "public_booking_count"),
  visits: nonNegativeInt(form, "visits"),
});

/** GET /admin/history/:hmac — render the contact record editor. Decrypting the
 * note needs the owner private key, so the session must hold one. */
export const handleContactHistoryGet: TypedRouteHandler<
  "GET /admin/history/:hmac"
> = (request, { hmac }) =>
  requireSessionOr(request, async (session) => {
    const record = await loadForRepair(
      fromContactHashParam(hmac),
      await requirePrivateKey(session),
    );
    const flash = applyFlash(request);
    return htmlResponse(
      contactHistoryPage({
        flashError: flash.error,
        flashSuccess: flash.success,
        hmac,
        record,
        session,
      }),
    );
  });

/** POST /admin/history/:hmac — overwrite the contact record from the form. */
export const handleContactHistoryPost: TypedRouteHandler<
  "POST /admin/history/:hmac"
> = (request, { hmac }) =>
  withAuth(request, AUTH_FORM, async (session, form) => {
    const pk = await requirePrivateKey(session);
    const hash = fromContactHashParam(hmac);
    const current = await loadForRepair(hash, pk);
    const updated = recordFromForm(form, current);
    if (updated.adminNotes.length > MAX_TEXTAREA_LENGTH) {
      return htmlResponse(
        contactHistoryPage({
          formError: t("contact_history.note_too_long", {
            max: MAX_TEXTAREA_LENGTH,
          }),
          hmac,
          record: updated,
          session,
        }),
      );
    }
    await saveContactRecord(hash, updated);
    return redirect(`/admin/history/${hmac}`, t("contact_history.saved"), true);
  });

export const contactHistoryRoutes = defineRoutes({
  "GET /admin/history/:hmac": handleContactHistoryGet,
  "POST /admin/history/:hmac": handleContactHistoryPost,
});
