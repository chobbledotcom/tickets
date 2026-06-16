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
import { Raw } from "#shared/jsx/jsx-runtime.ts";

export const DomainPaymentWebhookWarning = ({
  paymentProvider,
}: {
  paymentProvider: string;
}): JSX.Element | null => {
  if (paymentProvider !== "square" && paymentProvider !== "stripe") return null;
  return (
    <article>
      <aside role="alert">
        <p>
          <strong>{t("settings.domain_warning.title")}</strong>{" "}
          {t("settings.domain_warning.body")}
        </p>
        {paymentProvider === "square" ? (
          <p>
            <Raw html={t("settings.domain_warning.square")} />
          </p>
        ) : (
          <p>
            <Raw html={t("settings.domain_warning.stripe")} />
          </p>
        )}
      </aside>
    </article>
  );
};
