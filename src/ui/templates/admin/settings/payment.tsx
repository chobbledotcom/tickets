/**
 * Payment Provider, Stripe, Square, and Booking Fee forms for settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { MASK_SENTINEL } from "#shared/db/settings/mask.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { renderFields } from "#shared/forms/rendering.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_PROVIDERS,
  providerCurrencyBlock,
} from "#shared/payment-providers.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { RadioOption } from "#templates/components/radio-option.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import {
  getSquareAccessTokenFields,
  getSquareWebhookFields,
  getStripeKeyFields,
  getSumupFields,
} from "#templates/fields/admin.ts";

/* jscpd:ignore-end */

/** One payment-provider choice. A provider that cannot take the site's currency
 *  is shown switched off, with the reason beside it — the operator learns before
 *  pasting a key, not after. The site currency is set once at setup and never
 *  changes, so this cannot switch off a provider already in use. */
const ProviderOption = ({
  currency,
  id,
  selected,
}: {
  currency: string;
  id: PaymentProviderType;
  selected: boolean;
}): JSX.Element => {
  const currencyBlock = providerCurrencyBlock(id, currency);
  return (
    <RadioOption
      checked={selected}
      disabled={currencyBlock !== null}
      name="payment_provider"
      value={id}
    >
      {PAYMENT_PROVIDERS[id].label}
      {currencyBlock && <small class="notice">{currencyBlock}</small>}
    </RadioOption>
  );
};

export const PaymentProviderForm = (s: SettingsPageState): JSX.Element => (
  <SaveForm
    action="/admin/settings/payment-provider"
    id="settings-payment-provider"
    submitLabel={t("settings.save_payment_provider")}
  >
    <div class="prose">
      <h2>{t("settings.payment_provider")}</h2>
      <p>{t("settings.payment_provider_hint")}</p>
    </div>
    <fieldset class="radios">
      <RadioOption
        checked={!s.paymentProvider}
        name="payment_provider"
        value="none"
      >
        {t("settings.payment_none")}
      </RadioOption>
      {PAYMENT_PROVIDER_IDS.map((id) => (
        <ProviderOption
          currency={s.currency}
          id={id}
          selected={s.paymentProvider === id}
        />
      ))}
    </fieldset>
  </SaveForm>
);

/** Test/live mode notice for providers that use sk_test_/sk_live_ keys
 * (Stripe and SumUp). Renders nothing when the mode is unknown. */
const ApiKeyModeNotice = ({
  mode,
  provider,
}: {
  mode: string | null;
  provider: string;
}): JSX.Element | null => {
  if (mode === "test") {
    return (
      <p class="notice warning">
        <strong>Test mode:</strong> You are using a {provider} test key (
        <code>sk_test_</code>). No real charges will be made. Switch to a live
        key (<code>sk_live_</code>) when you are ready to accept real payments.
      </p>
    );
  }
  if (mode === "live") {
    return (
      <p class="notice">
        <strong>Live mode:</strong> You are using a {provider} live key.
        Payments will be charged for real.
      </p>
    );
  }
  return null;
};

/** Small "Where do I find this?" footnote linking to the payment setup guide,
 *  shared by the provider credential forms. */
const PaymentGuideLink = ({ label }: { label: string }): JSX.Element => (
  <p>
    <small>
      <a href="/admin/guide#payment-setup">{label}</a>
    </small>
  </p>
);

/** The save/Test Connection footer plus its hidden result div, shared by the
 *  Stripe and SumUp key forms. Curried by the provider's id-slug, the
 *  "Update <provider> Credentials" label, and the "Test Connection" label. */
const paymentTestFooter = (
  provider: string,
  keyConfigured: boolean,
  updateLabel: string,
  testConnectionLabel: string,
): JSX.Element => (
  <>
    <footer>
      <SubmitButton icon="save">{updateLabel}</SubmitButton>
      {keyConfigured && (
        <button class="secondary" id={`${provider}-test-btn`} type="button">
          {testConnectionLabel}
        </button>
      )}
    </footer>
    <div class="hidden" id={`${provider}-test-result`} />
  </>
);

/** The credentials body shared by the Stripe and SumUp key forms: the
 *  test/live-mode notice (when a key is set), the "where do I find this" guide
 *  link, the masked key fields, and the save/Test Connection footer. Each
 *  provider supplies only its own display name, id-slug, labels, field list and
 *  mask key. */
const ProviderKeyBlock = ({
  configured,
  fields,
  guideLabel,
  maskKey,
  mode,
  provider,
  providerId,
  testLabel,
  updateLabel,
}: {
  configured: boolean;
  fields: Parameters<typeof renderFields>[0];
  guideLabel: string;
  maskKey: string;
  mode: string | null;
  provider: string;
  providerId: string;
  testLabel: string;
  updateLabel: string;
}): JSX.Element => (
  <>
    {configured && <ApiKeyModeNotice mode={mode} provider={provider} />}
    <PaymentGuideLink label={guideLabel} />
    <Raw
      html={renderFields(
        fields,
        configured ? { [maskKey]: MASK_SENTINEL } : {},
      )}
    />
    {paymentTestFooter(providerId, configured, updateLabel, testLabel)}
  </>
);

/** The heading and "configured / not configured" hint that opens each payment
 *  provider's settings form. `keyPrefix` is the provider's i18n namespace
 *  ("settings.stripe", "settings.square", "settings.sumup"); `configured` picks
 *  which hint to show. `children` holds anything extra the provider tucks inside
 *  the prose block (Square's guide link). */
const ProviderIntro = ({
  keyPrefix,
  configured,
  children,
}: {
  keyPrefix: string;
  configured: boolean;
  children?: Child;
}): JSX.Element => (
  <div class="prose">
    <h2>{t(`${keyPrefix}.heading`)}</h2>
    <p>
      {configured
        ? t(`${keyPrefix}.configured_hint`)
        : t(`${keyPrefix}.not_configured_hint`)}
    </p>
    {children}
  </div>
);

export const StripeForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider === "stripe" ? (
    <CsrfForm action="/admin/settings/stripe" id="settings-stripe">
      <ProviderIntro
        configured={s.stripeKeyConfigured}
        keyPrefix="settings.stripe"
      />
      <ProviderKeyBlock
        configured={s.stripeKeyConfigured}
        fields={getStripeKeyFields()}
        guideLabel={t("settings.stripe.where_to_find")}
        maskKey="stripe_secret_key"
        mode={s.stripeKeyMode}
        provider="Stripe"
        providerId="stripe"
        testLabel={t("settings.stripe.test_connection")}
        updateLabel={t("settings.stripe.update_key")}
      />
    </CsrfForm>
  ) : null;

export const SquareForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider === "square" ? (
    <CsrfForm action="/admin/settings/square" id="settings-square">
      <ProviderIntro
        configured={s.squareTokenConfigured}
        keyPrefix="settings.square"
      >
        <PaymentGuideLink label={t("settings.square.where_to_find")} />
      </ProviderIntro>
      <Raw
        html={renderFields(
          getSquareAccessTokenFields(),
          s.squareTokenConfigured ? { square_access_token: MASK_SENTINEL } : {},
        )}
      />
      <label>
        <input
          checked={s.squareSandbox}
          name="square_sandbox"
          type="checkbox"
        />
        {t("settings.square.sandbox_mode")}
      </label>
      <footer>
        <SubmitButton icon="save">
          {t("settings.square.update_credentials")}
        </SubmitButton>
        {s.squareTokenConfigured && (
          <button class="secondary" id="square-test-btn" type="button">
            {t("settings.square.test_connection")}
          </button>
        )}
      </footer>
      <div class="hidden" id="square-test-result"></div>
    </CsrfForm>
  ) : null;

export const SquareWebhookForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider === "square" && s.squareTokenConfigured ? (
    <SaveForm
      action="/admin/settings/square-webhook"
      id="settings-square-webhook"
      submitLabel={t("settings.square.update_webhook_key")}
    >
      <div class="prose">
        <h2>{t("settings.square.webhook_heading")}</h2>
        <p>
          <a href="/admin/guide#payment-setup">
            {t("settings.square.webhook_guide_link")}
          </a>
        </p>
      </div>
      <article>
        <aside>
          <p>{t("settings.square.webhook_instructions")}</p>
          <ol>
            <li>
              Go to your <strong>Square Developer Dashboard</strong> and select
              your application
            </li>
            <li>
              Navigate to <strong>Webhooks</strong> in the left sidebar
            </li>
            <li>
              Click <strong>Add Subscription</strong>
            </li>
            <li>
              Set the <strong>Notification URL</strong> to:
              <br />
              <code>{s.webhookUrl}</code>
            </li>
            <li>
              Subscribe to the <strong>payment.updated</strong> event
            </li>
            <li>
              Save the subscription and copy the <strong>Signature Key</strong>
            </li>
            <li>Paste the signature key below</li>
          </ol>
        </aside>
      </article>
      <p>
        {s.squareWebhookConfigured
          ? t("settings.square.webhook_configured_hint")
          : t("settings.square.webhook_not_configured_hint")}
      </p>
      <Raw
        html={renderFields(
          getSquareWebhookFields(),
          s.squareWebhookConfigured
            ? { square_webhook_signature_key: MASK_SENTINEL }
            : {},
        )}
      />
    </SaveForm>
  ) : null;

export const SumUpForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider === "sumup" ? (
    <CsrfForm action="/admin/settings/sumup" id="settings-sumup">
      <ProviderIntro
        configured={s.sumupKeyConfigured}
        keyPrefix="settings.sumup"
      />
      <ProviderKeyBlock
        configured={s.sumupKeyConfigured}
        fields={getSumupFields()}
        guideLabel={t("settings.sumup.where_to_find")}
        maskKey="sumup_api_key"
        mode={s.sumupKeyMode}
        provider="SumUp"
        providerId="sumup"
        testLabel={t("settings.sumup.test_connection")}
        updateLabel={t("settings.sumup.update_key")}
      />
    </CsrfForm>
  ) : null;

export const BookingFeeForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider ? (
    <SaveForm
      action="/admin/settings/booking-fee"
      id="settings-booking-fee"
      submitLabel={t("settings.save_booking_fee")}
    >
      <div class="prose">
        <h2>{t("settings.booking_fee")}</h2>
        <p>{t("settings.booking_fee_hint")}</p>
      </div>
      <label>
        {t("settings.booking_fee_label")}
        <input
          max="10"
          min="0"
          name="booking_fee"
          required
          step="0.1"
          type="number"
          value={s.bookingFee}
        />
      </label>
    </SaveForm>
  ) : null;
