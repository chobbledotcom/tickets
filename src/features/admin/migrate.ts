/** One-off migration pages: repairs for records written by older releases.
 *
 * The rebuild page gives a site's owner one address to send people to when
 * payments taken by an older release cannot be refunded in the app. */

import { logActivity } from "#db/activity-log.ts";
import {
  countLegacyPaymentReferences,
  rebuildLegacyPaymentReferences,
} from "#db/payment-reference-rebuild.ts";
import { t } from "#i18n";
import { ownerResponsePage } from "#routes/auth.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { ownerFormHandler } from "#shared/app-forms.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { adminMigrateRebuildPaymentsPage } from "#templates/admin/migrate.tsx";
import { isPaymentProvider } from "#types";
import { verifyOrRedirect } from "./confirmation.ts";

const REBUILD_PATH = "/admin/migrate/rebuild-payment-references";

const handleRebuildGet = ownerResponsePage(async (session, _request, flash) => {
  const remaining = await countLegacyPaymentReferences();
  return htmlResponse(
    adminMigrateRebuildPaymentsPage(session, {
      error: flash.error,
      info: flash.info,
      remaining,
      success: flash.success,
    }),
  );
});

const handleRebuildPost = ownerFormHandler(async ({ form }) => {
  const provider = form.getString("provider");
  if (!isPaymentProvider(provider)) {
    return errorRedirect(REBUILD_PATH, t("migrate.rebuild.error_provider"));
  }
  const mismatch = verifyOrRedirect(form, provider, REBUILD_PATH, "Provider");
  if (mismatch !== null) return mismatch;

  const { rebuilt, remaining } = await rebuildLegacyPaymentReferences(
    provider,
    await requireRequestPrivateKey(),
  );
  await logActivity(
    t("migrate.rebuild.log_rebuilt", {
      count: rebuilt,
      provider: PAYMENT_PROVIDERS[provider].label,
    }),
  );
  return redirect(
    REBUILD_PATH,
    remaining === 0
      ? t("migrate.rebuild.flash_done", { count: rebuilt })
      : t("migrate.rebuild.flash_progress", { rebuilt, remaining }),
    true,
  );
});

/** Migration page routes */
export const adminHandlers = defineRoutes({
  "GET /admin/migrate/rebuild-payment-references": handleRebuildGet,
  "POST /admin/migrate/rebuild-payment-references": handleRebuildPost,
});
