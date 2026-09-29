/** One-off migration pages: repairs for records written by older releases.
 *
 * The rebuild page gives a site's owner one address to send people to when
 * payments taken by an older release cannot be refunded in the app. It lists
 * the rows the next run would rewrite, because the owner is the only one who
 * knows which provider took each of them: a site can change provider, so one
 * page of old rows can span several. */

import { logActivity } from "#db/activity-log.ts";
import {
  countLegacyPaymentReferences,
  type LegacyPaymentReferencePreview,
  legacyPaymentReferencePage,
  rebuildLegacyPaymentReferences,
  type StatedPaymentProviders,
} from "#db/payment-reference-rebuild.ts";
import { t } from "#i18n";
import { ownerResponsePage } from "#routes/auth.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { ownerFormHandler } from "#shared/app-forms.ts";
import type { FormParams } from "#shared/form-data.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { adminMigrateRebuildPaymentsPage } from "#templates/admin/migrate.tsx";
import { isPaymentProvider, type PaymentProviderType } from "#types";
import { verifyOrRedirect } from "./confirmation.ts";

const REBUILD_PATH = "/admin/migrate/rebuild-payment-references";

/** The form field one row's provider choice arrives in. The session id is
 * escaped so a reference that carries a `&` or `=` cannot read as another
 * row's field. */
const providerField = (paymentSessionId: string): string =>
  `provider_${encodeURIComponent(paymentSessionId)}`;

/** The provider the owner stated for each row that needs one, or null when a
 * row is left unstated - the run then fails rather than guessing. */
const statedProvidersFor = (
  form: FormParams,
  page: readonly LegacyPaymentReferencePreview[],
): StatedPaymentProviders | null => {
  const providers = new Map<string, PaymentProviderType>();
  for (const row of page) {
    if (row.alreadyTagged) {
      continue;
    }
    const stated = form.getString(providerField(row.paymentSessionId));
    if (!isPaymentProvider(stated)) {
      return null;
    }
    providers.set(row.paymentSessionId, stated);
  }
  return providers;
};

/** The rows whose provider the owner has to state: everything the page does
 * not already name. */
const rowsNeedingProvider = (
  page: readonly LegacyPaymentReferencePreview[],
): LegacyPaymentReferencePreview[] => page.filter((row) => !row.alreadyTagged);

const handleRebuildGet = ownerResponsePage(async (session, _request, flash) => {
  const [remaining, page] = await Promise.all([
    countLegacyPaymentReferences(),
    legacyPaymentReferencePage(await requireRequestPrivateKey()),
  ]);
  return htmlResponse(
    adminMigrateRebuildPaymentsPage(session, {
      error: flash.error,
      info: flash.info,
      page,
      remaining,
      success: flash.success,
    }),
  );
});

const handleRebuildPost = ownerFormHandler(async ({ form }) => {
  const privateKey = await requireRequestPrivateKey();
  const page = await legacyPaymentReferencePage(privateKey);
  const providers = statedProvidersFor(form, page);
  if (providers === null) {
    return errorRedirect(REBUILD_PATH, t("migrate.rebuild.error_provider"));
  }
  const toTag = rowsNeedingProvider(page).length;
  const mismatch = verifyOrRedirect(
    form,
    String(toTag),
    REBUILD_PATH,
    t("migrate.rebuild.confirm_count_label"),
  );
  if (mismatch !== null) return mismatch;

  const { rebuilt, remaining, unqualified } =
    await rebuildLegacyPaymentReferences(providers, privateKey);
  await logActivity(
    t("migrate.rebuild.log_rebuilt", { count: rebuilt, unqualified }),
  );
  return redirect(
    REBUILD_PATH,
    remaining === 0
      ? t("migrate.rebuild.flash_done", { count: rebuilt, unqualified })
      : t("migrate.rebuild.flash_progress", {
          rebuilt,
          remaining,
          unqualified,
        }),
    true,
  );
});

/** Migration page routes */
export const adminHandlers = defineRoutes({
  "GET /admin/migrate/rebuild-payment-references": handleRebuildGet,
  "POST /admin/migrate/rebuild-payment-references": handleRebuildPost,
});
