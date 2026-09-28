/** Rebuild page (owner-only): repairs payments taken by an older release.
 *
 * The one address support sends people to when a payment cannot be refunded
 * because its stored record predates the blind payment index. */

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
import { RadioOption } from "#templates/components/radio-option.tsx";
import type { AdminSession } from "#types";

export type RebuildPaymentsPageData = {
  /** Payment rows that still wait for the rebuild. */
  remaining: number;
} & FlashFields;

const ProviderChoice = (): JSX.Element => (
  <fieldset class="radios">
    <legend>{t("migrate.rebuild.provider_label")}</legend>
    {PAYMENT_PROVIDER_IDS.map((id) => (
      <RadioOption checked={false} name="provider" required value={id}>
        {PAYMENT_PROVIDERS[id].label}
      </RadioOption>
    ))}
  </fieldset>
);

const RebuildForm = (): JSX.Element => (
  <CsrfForm
    action="/admin/migrate/rebuild-payment-references"
    id="migrate-rebuild"
  >
    <ProviderChoice />
    <small>{t("migrate.rebuild.provider_hint")}</small>
    <label>
      {t("migrate.rebuild.confirm_label")}
      <input autocomplete="off" name="confirm_identifier" type="text" />
    </label>
    <p class="actions">
      <button type="submit">{t("migrate.rebuild.button")}</button>
    </p>
  </CsrfForm>
);

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
      {data.remaining > 0 && <RebuildForm />}
    </>,
  );
