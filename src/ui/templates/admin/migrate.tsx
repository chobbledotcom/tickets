/** Rebuild page (owner-only): repairs payments taken by an older release.
 *
 * The one address support sends people to when a payment cannot be refunded
 * because its stored record predates the blind payment index. The old records
 * do not say which provider took them and a site can change provider, so the
 * page lists the rows the next run would rewrite and takes the owner's
 * provider for each of them. */

import type { LegacyPaymentReferencePreview } from "#db/payment-reference-rebuild.ts";
import { t } from "#i18n";
import type { FlashFields } from "#shared/flash-fields.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { Flash } from "#shared/forms/flash.tsx";
import {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_PROVIDERS,
} from "#shared/payment-providers.ts";
import { renderAdminPage } from "#templates/admin/admin-page.tsx";
import { ProseHtml } from "#templates/components/prose-html.tsx";
import type { AdminSession } from "#types";

export type RebuildPaymentsPageData = {
  /** The rows the next run would rewrite. */
  page: readonly LegacyPaymentReferencePreview[];
  /** Payment rows that still wait for the rebuild. */
  remaining: number;
} & FlashFields;

/** The form field one row's provider choice arrives in. */
const providerField = (paymentSessionId: string): string =>
  `provider_${encodeURIComponent(paymentSessionId)}`;

/** One old record, with a provider choice when the record does not name one. */
const RecordRow = ({
  row,
}: {
  row: LegacyPaymentReferencePreview;
}): JSX.Element => (
  <tr>
    <td>{row.reference}</td>
    <td>{row.processedAt.slice(0, 10)}</td>
    <td>
      {row.alreadyTagged ? (
        t("migrate.rebuild.already_tagged")
      ) : (
        <label>
          {t("migrate.rebuild.row_provider_label")}
          <select name={providerField(row.paymentSessionId)} required>
            <option value="">{t("migrate.rebuild.choose_provider")}</option>
            {PAYMENT_PROVIDER_IDS.map((id) => (
              <option value={id}>{PAYMENT_PROVIDERS[id].label}</option>
            ))}
          </select>
        </label>
      )}
    </td>
  </tr>
);

const RebuildForm = ({
  page,
}: {
  page: readonly LegacyPaymentReferencePreview[];
}): JSX.Element => {
  const toTag = page.filter((record) => !record.alreadyTagged).length;
  return (
    <CsrfForm
      action="/admin/migrate/rebuild-payment-references"
      id="migrate-rebuild"
    >
      <table>
        <thead>
          <tr>
            <th scope="col">{t("migrate.rebuild.column_reference")}</th>
            <th scope="col">{t("migrate.rebuild.column_date")}</th>
            <th scope="col">{t("migrate.rebuild.column_provider")}</th>
          </tr>
        </thead>
        <tbody>
          {page.map((row) => (
            <RecordRow row={row} />
          ))}
        </tbody>
      </table>
      <small>{t("migrate.rebuild.provider_hint")}</small>
      <label>
        {t("migrate.rebuild.confirm_count", { count: toTag })}
        <input
          autocomplete="off"
          inputmode="numeric"
          name="confirm_identifier"
          type="text"
        />
      </label>
      <p class="actions">
        <button type="submit">{t("migrate.rebuild.button")}</button>
      </p>
    </CsrfForm>
  );
};

export const adminMigrateRebuildPaymentsPage = (
  session: AdminSession,
  data: RebuildPaymentsPageData,
): string =>
  renderAdminPage(
    "/admin/migrate/rebuild-payment-references",
    session,
    t("migrate.rebuild.heading"),
    <>
      <ProseHtml html={t("migrate.rebuild.intro_html")}>
        <p>{t("migrate.rebuild.records_waiting", { count: data.remaining })}</p>
        {data.remaining === 0 && <p>{t("migrate.rebuild.nothing_to_do")}</p>}
      </ProseHtml>
      <Flash {...data} />
      {data.remaining > 0 && <RebuildForm page={data.page} />}
    </>,
  );
