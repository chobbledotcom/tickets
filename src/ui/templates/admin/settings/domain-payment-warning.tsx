/**
 * Warning shown in the domain settings forms: changing the site's domain
 * changes the payment webhook URL, so a provider that sends webhooks must be
 * set up again afterwards or payments stop being confirmed.
 *
 * Which providers those are, and what each one's operator must redo, come
 * from the provider registry. A provider that sends no webhook has nothing to
 * repoint, so it gets no warning.
 */

import { t } from "#i18n";
import { providerWebhook } from "#shared/payment-providers.ts";
import { rawParagraph } from "#templates/components/raw-paragraph.tsx";
import type { PaymentProviderType } from "#types";

export const DomainPaymentWebhookWarning = ({
  existingPaymentProvider,
  paymentProviderRecoveryNeeded,
}: {
  existingPaymentProvider: PaymentProviderType | null;
  paymentProviderRecoveryNeeded: boolean;
}): JSX.Element | null => {
  if (paymentProviderRecoveryNeeded) {
    return (
      <article>
        <aside role="alert">
          <p>
            <strong>{t("settings.domain_recovery_required")}</strong>{" "}
            <a href="/admin/settings#settings-payment-provider-recovery">
              {t("settings.domain_recovery_link")}
            </a>
            .
          </p>
        </aside>
      </article>
    );
  }
  const webhook =
    existingPaymentProvider === null
      ? null
      : providerWebhook(existingPaymentProvider);
  if (webhook === null) return null;
  return (
    <article>
      <aside role="alert">
        <p>
          <strong>{t("settings.domain_warning.title")}</strong>{" "}
          {t("settings.domain_warning.body")}
        </p>
        {rawParagraph(webhook.domainChangeFixKey)}
      </aside>
    </article>
  );
};
