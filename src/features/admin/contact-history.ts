/* jscpd:ignore-start -- imports */
import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import type { TypedRouteHandler } from "#routes/router.ts";

/**
 * The entity page for a single contact_preferences record, keyed by its HMAC
 * blind index (contact_hash). The attendee page's contact-history panel links
 * here so the operator can inspect and repair a contact's aggregated
 * booking/message counts and owner-encrypted private note directly.
 *
 *   GET  /admin/history/:hmac — render the record editor
 *   POST /admin/history/:hmac — save the edited record
 */

import {
  type ContactRecord,
  fromContactHashParam,
  getContactRecordOrRepair,
  saveContactRecord,
} from "#db/contact-preferences.ts";
import { addPageImageUrls } from "#db/image-urls.ts";
import { t } from "#i18n";
import {
  customSection,
  defineEntityPage,
  type EntityPage,
} from "#routes/admin/entity-pages.ts";
import { AUTH_FORM, withAuth } from "#routes/auth.ts";
import { redirect } from "#routes/response.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import type { FormParams } from "#shared/form-data.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  ContactHistoryForm,
  ContactHistoryProse,
} from "#templates/admin/contact-history.tsx";

/* jscpd:ignore-end */

/** Load the record for the editor, tolerating a corrupt stats blob. This
 * editor is the repair path, so a decryption failure must not lock the
 * operator out. */
const loadForRepair = getContactRecordOrRepair("contact history editor");

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

/** The editor's page entity: the route's HMAC blind index plus the loaded
 * record, so the prose and form can show the contact's own hash. */
type ContactHistoryEntity = { hmac: string; record: ContactRecord };

/** The editor form, with the request's private key opening the record's note
 * (the session must hold one). */
const loadContactHistoryEntity = async (
  hmac: string,
): Promise<ContactHistoryEntity> => ({
  hmac,
  record: await loadForRepair(
    fromContactHashParam(hmac),
    await requireRequestPrivateKey(),
  ),
});

/** The prose beside the heading: what the editor is for, and which contact. */
const entityProse = ({ hmac }: ContactHistoryEntity): JSX.Element =>
  ContactHistoryProse({ hmac });

/** The editor form panel: the page's one section. The note's img#N references
 * resolve through the image-url table before render. */
const loadFormPanel = async ({
  hmac,
  record,
}: ContactHistoryEntity): Promise<JSX.Element> => {
  await addPageImageUrls([record.adminNotes]);
  return ContactHistoryForm({ hmac, record });
};

/** The tabbed contact-record editor. */
const contactHistoryEntityPage: EntityPage<ContactHistoryEntity, string> =
  defineEntityPage({
    destination: "contactHistory",
    load: (hmac) => loadContactHistoryEntity(hmac),
    navActive: { section: adminPattern("attendees") },
    proseExtra: (entity) => Promise.resolve(entityProse(entity)),
    tabs: [
      {
        intent: "write-form",
        labelKey: "entity.tab.edit",
        sections: [customSection(loadFormPanel)],
        slug: "",
      },
    ],
    titleOf: () => t("contact_history.title"),
  });

/** POST /admin/history/:hmac — overwrite the contact record from the form. */
const handleContactHistoryPost: TypedRouteHandler<
  "POST /admin/history/:hmac"
> = (request, { hmac }) =>
  withAuth(request, AUTH_FORM, async (session, form) => {
    const pk = await requireRequestPrivateKey();
    const hash = fromContactHashParam(hmac);
    const current = await loadForRepair(hash, pk);
    const updated = recordFromForm(form, current);
    if (updated.adminNotes.length > MAX_TEXTAREA_LENGTH) {
      await addPageImageUrls([updated.adminNotes]);
      return contactHistoryEntityPage.renderPage(session, hmac, "", {
        panel: () =>
          Promise.resolve(
            ContactHistoryForm({
              formError: t("contact_history.note_too_long", {
                max: MAX_TEXTAREA_LENGTH,
              }),
              hmac,
              record: updated,
            }),
          ),
      });
    }
    await saveContactRecord(hash, updated);
    return redirect(`/admin/history/${hmac}`, t("contact_history.saved"), true);
  });

export const adminHandlers = defineAdminRoutes({
  "GET /admin/history/:hmac": (request, { hmac }) =>
    contactHistoryEntityPage.renderTab(request, hmac, ""),
  "POST /admin/history/:hmac": handleContactHistoryPost,
});
