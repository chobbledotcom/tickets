/**
 * Privacy page routes (owner-only).
 *
 * Hosts the data-minimisation tools described in plain language on the page:
 * purging orphaned attendee records (records left with no listing booking),
 * toggling whether that purge runs automatically, and performing a GDPR
 * erasure of a single contact's recognition record by email or phone.
 */

import { t } from "#i18n";
import { OWNER_FORM, ownerPage } from "#routes/auth.ts";
import { errorRedirect, infoRedirect, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { contactHash, forgetContact } from "#shared/db/contact-preferences.ts";
import {
  countOrphanedAttendees,
  purgeOrphanedAttendees,
} from "#shared/db/orphan-attendees.ts";
import { settings } from "#shared/db/settings.ts";
import { getFlash } from "#shared/flash-context.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import {
  isOrphanRetentionValue,
  orphanRetentionCutoffIso,
} from "#shared/orphan-retention.ts";
import { adminPrivacyPage } from "#templates/admin/privacy.tsx";

const PRIVACY_PATH = "/admin/privacy";

/** GET /admin/privacy — explainer plus the orphan-purge and erasure forms. */
const handlePrivacyGet = ownerPage(async (session) => {
  const orphanCount = await countOrphanedAttendees(nowIso());
  const flash = getFlash();
  return adminPrivacyPage(session, {
    autoPurgeOrphans: settings.autoPurgeOrphans,
    error: flash.error,
    info: flash.info,
    orphanCount,
    orphanRetention: settings.orphanPurgeRetention,
    success: flash.success,
  });
});

/**
 * POST /admin/privacy/orphans — save the retention age and auto-purge toggle.
 * The "Delete now" button additionally purges matching records immediately;
 * the "Save" button only stores the settings.
 */
const handleOrphansPost = createAuthedHandler({
  auth: OWNER_FORM,
  handle: async ({ form }) => {
    const retention = form.getString("retention");
    if (!isOrphanRetentionValue(retention)) {
      return errorRedirect(PRIVACY_PATH, t("privacy.orphans.error_retention"));
    }
    await settings.update.orphanPurgeRetention(retention);
    await settings.update.autoPurgeOrphans(form.has("auto_purge"));

    if (form.getString("action") === "purge") {
      const deleted = await purgeOrphanedAttendees(
        orphanRetentionCutoffIso(retention, nowMs()),
      );
      await logActivity(t("privacy.orphans.log_purged", { count: deleted }));
      return redirect(
        PRIVACY_PATH,
        t("privacy.orphans.flash_purged", { count: deleted }),
        true,
      );
    }
    return redirect(PRIVACY_PATH, t("privacy.orphans.flash_saved"), true);
  },
});

/**
 * POST /admin/privacy/erase — delete one contact's recognition record, found
 * by hashing the entered email or phone the same way bookings record it.
 */
const handleErasePost = createAuthedHandler({
  auth: OWNER_FORM,
  handle: async ({ form }) => {
    const channel = form.getString("contact_type");
    const identifier = form.getString("identifier").trim();
    if (!identifier) {
      return errorRedirect(PRIVACY_PATH, t("privacy.erase.error_identifier"));
    }
    if (channel !== "email" && channel !== "sms") {
      return errorRedirect(PRIVACY_PATH, t("privacy.erase.error_type"));
    }
    const deleted = await forgetContact(await contactHash(channel, identifier));
    if (deleted === 0) {
      return infoRedirect(PRIVACY_PATH, t("privacy.erase.flash_none"));
    }
    await logActivity(t("privacy.erase.log_done"));
    return redirect(PRIVACY_PATH, t("privacy.erase.flash_done"), true);
  },
});

/** Privacy routes */
export const privacyRoutes = defineRoutes({
  "GET /admin/privacy": handlePrivacyGet,
  "POST /admin/privacy/erase": handleErasePost,
  "POST /admin/privacy/orphans": handleOrphansPost,
});
