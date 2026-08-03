/**
 * Warning shown in the domain settings forms: changing the site's domain
 * changes the payment webhook URL, so webhook-based payment providers
 * (Square and Stripe) must be reconfigured afterwards or payments stop
 * being confirmed.
 *
 * SumUp has no webhook, so the warning is hidden for it (and when no
 * provider is configured).
 */

import { t } from "#i18n";
import { rawParagraph } from "#templates/components/raw-paragraph.tsx";

export const DomainPaymentWebhookWarning = ({
  existingPaymentProvider,
  paymentProviderRecoveryNeeded,
}: {
  existingPaymentProvider: string | null;
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
  if (
    existingPaymentProvider !== "square" &&
    existingPaymentProvider !== "stripe"
  )
    return null;
  return (
    <article>
      <aside role="alert">
        <p>
          <strong>{t("settings.domain_warning.title")}</strong>{" "}
          {t("settings.domain_warning.body")}
        </p>
        {existingPaymentProvider === "square"
          ? rawParagraph("settings.domain_warning.square")
          : rawParagraph("settings.domain_warning.stripe")}
      </aside>
    </article>
  );
};
