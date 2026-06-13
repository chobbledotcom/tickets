/**
 * Warning shown in the domain settings forms: changing the site's domain
 * changes the payment webhook URL, so webhook-based payment providers
 * (Square and Stripe) must be reconfigured afterwards or payments stop
 * being confirmed.
 *
 * SumUp has no webhook, so the warning is hidden for it (and when no
 * provider is configured).
 */

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
          <strong>
            Changing your domain changes your payment webhook URL.
          </strong>{" "}
          Your payment provider sends booking confirmations to a webhook at your
          current domain. After you change or set your domain here, you must
          update your webhook or new payments will stop being confirmed:
        </p>
        {paymentProvider === "square" ? (
          <p>
            In your <strong>Square Developer Dashboard</strong>, update your
            webhook subscription's Notification URL to the new address, then
            paste the Signature Key back into the{" "}
            <a href="/admin/settings#settings-square-webhook">
              Square settings
            </a>
            .
          </p>
        ) : (
          <p>
            Re-save your key on the{" "}
            <a href="/admin/settings#settings-stripe">Stripe settings</a> page
            to point the webhook at the new domain.
          </p>
        )}
      </aside>
    </article>
  );
};
