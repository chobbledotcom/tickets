/**
 * The payment-provider choice, the one credentials form every provider uses,
 * and Square's separate webhook-key form.
 */

import { MASK_SENTINEL } from "#db/settings/mask.ts";
/* jscpd:ignore-start */
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { renderFields } from "#shared/forms/rendering.tsx";
import type { PaymentProviderMode } from "#shared/payment-provider-status.ts";
import {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_PROVIDERS,
  providerCurrencyBlock,
} from "#shared/payment-providers.ts";
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
import type { PaymentProviderType } from "#types";

/* jscpd:ignore-end */

/** One payment-provider choice, switched off with a reason when the site
 *  currency rules it out. Currency is write-once at setup, so a provider
 *  already in use can never be switched off underneath the operator. */
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

/** Square alone points at a separate test estate, and the operator switches
 *  to it here rather than by swapping the credentials. */
const SquareSandboxToggle = (mode: PaymentProviderMode): JSX.Element => (
  <label>
    <input checked={mode === "sandbox"} name="square_sandbox" type="checkbox" />
    {t("settings.square.sandbox_mode")}
  </label>
);

/** What one provider's credentials form asks for beyond the shared shape:
 *  the fields it shows, and any extra control only it needs. */
type CredentialsView = {
  readonly extraControl?: (mode: PaymentProviderMode) => JSX.Element;
  readonly fields: () => Parameters<typeof renderFields>[0];
};

const CREDENTIALS_VIEW: Record<PaymentProviderType, CredentialsView> = {
  square: {
    extraControl: SquareSandboxToggle,
    fields: getSquareAccessTokenFields,
  },
  stripe: { fields: getStripeKeyFields },
  sumup: { fields: getSumupFields },
};

/** What the notice says about each estate, or nothing when the stored
 *  credentials do not name one. */
const MODE_NOTICE: Record<PaymentProviderMode, string | null> = {
  live: "settings.provider.mode_live",
  sandbox: "settings.provider.mode_sandbox",
  test: "settings.provider.mode_test",
  unknown: null,
};

/** Which estate the stored credentials point at. Only live money is not a
 *  warning, so every other estate is styled as one. */
const ModeNotice = ({
  mode,
  provider,
}: {
  mode: PaymentProviderMode;
  provider: PaymentProviderType;
}): JSX.Element | null => {
  const key = MODE_NOTICE[mode];
  return key === null ? null : (
    <p class={mode === "live" ? "notice" : "notice warning"}>
      <Raw
        html={t(key, {
          provider: escapeHtml(PAYMENT_PROVIDERS[provider].label),
        })}
      />
    </p>
  );
};

/** The credentials form of whichever provider the page shows. Route, form id
 *  and test-button ids all come from the provider's own name, so
 *  CREDENTIALS_VIEW above is the only place this form names a provider. */
export const ProviderCredentialsForm = (
  s: SettingsPageState,
): JSX.Element | null => {
  const shown = s.shownPaymentProvider;
  if (shown === null) return null;
  const { configured, mode, provider } = shown;
  const { extraControl, fields } = CREDENTIALS_VIEW[provider];
  const { label, secretField } = PAYMENT_PROVIDERS[provider];
  return (
    <CsrfForm
      action={`/admin/settings/${provider}`}
      id={`settings-${provider}`}
    >
      <div class="prose">
        <h2>{t("settings.provider.heading", { provider: label })}</h2>
        <p>
          {configured
            ? t("settings.provider.configured_hint", { provider: label })
            : t("settings.provider.not_configured_hint", { provider: label })}
        </p>
      </div>
      {configured && <ModeNotice mode={mode} provider={provider} />}
      <p>
        <small>
          <a href="/admin/guide#payment-setup">
            {t("settings.provider.guide_link")}
          </a>
        </small>
      </p>
      <Raw
        html={renderFields(
          fields(),
          configured ? { [secretField]: MASK_SENTINEL } : {},
        )}
      />
      {extraControl?.(mode)}
      <footer>
        <SubmitButton icon="save">
          {t("settings.provider.update_credentials", { provider: label })}
        </SubmitButton>
        {configured && (
          <button
            class="secondary"
            data-testing={t("settings.connection.testing")}
            id={`${provider}-test-btn`}
            type="button"
          >
            {t("settings.provider.test_connection")}
          </button>
        )}
      </footer>
      <div
        class="hidden"
        data-failed={t("settings.connection.failed")}
        id={`${provider}-test-result`}
      />
    </CsrfForm>
  );
};

/** Square's webhook signature key, asked for once its access token is
 *  stored. No other provider needs a key pasted in by hand. */
export const SquareWebhookForm = (s: SettingsPageState): JSX.Element | null => {
  const shown = s.shownPaymentProvider;
  return shown?.provider === "square" && shown.configured ? (
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
};
