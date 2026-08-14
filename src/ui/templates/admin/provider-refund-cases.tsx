/* jscpd:ignore-start -- imports */
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import type {
  ProviderRefundCase,
  ProviderRefundCasePage,
} from "#shared/db/provider-refund-cases.ts";
import type { FlashFields } from "#shared/flash-fields.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { Flash } from "#shared/forms/flash.tsx";
import type { RefundOwnerChoiceReason } from "#shared/payment/refund-authority.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import type { AdminSession } from "#shared/types.ts";
import { renderAdminPage } from "#templates/admin/admin-page.tsx";
import { WritableLink, WritableOnly } from "#templates/admin/writable-only.tsx";
import { RadioOption } from "#templates/components/radio-option.tsx";

/* jscpd:ignore-end */

const CASE_PATH = "/admin/privacy/refunds";

const STATE_LABELS = {
  completed: "privacy.refunds.state.completed",
  needs_owner_choice: "privacy.refunds.state.needs_owner_choice",
  observing: "privacy.refunds.state.observing",
  ready: "privacy.refunds.state.ready",
  send_armed: "privacy.refunds.state.send_armed",
} as const satisfies Record<ProviderRefundCase["state"], string>;

const REASON_LABELS = {
  possibly_sent: "privacy.refunds.reason.possibly_sent",
  provider_conflict: "privacy.refunds.reason.provider_conflict",
  provider_rejected: "privacy.refunds.reason.provider_rejected",
  replay_window_expired: "privacy.refunds.reason.replay_window_expired",
} as const satisfies Record<RefundOwnerChoiceReason, string>;

const STATE_EXPLANATIONS = {
  completed: "privacy.refunds.explanation.completed",
  needs_owner_choice: "privacy.refunds.choice_intro",
  observing: "privacy.refunds.explanation.observing",
  ready: "privacy.refunds.explanation.ready",
  send_armed: "privacy.refunds.explanation.send_armed",
} as const satisfies Record<ProviderRefundCase["state"], string>;

const stateLabel = (state: ProviderRefundCase["state"]): string =>
  t(STATE_LABELS[state]);

/** The bounded refund-recovery queue. Its rows contain no reversible payment
 * reference, so rendering this list never needs the owner's private key. */
export const ProviderRefundCaseQueue = ({
  page,
}: {
  page: ProviderRefundCasePage;
}): JSX.Element | null =>
  page.cases.length === 0 ? null : (
    <section class="prose" id="refund-recovery">
      <h2>{t("privacy.refunds.heading")}</h2>
      <p>{t("privacy.refunds.intro")}</p>
      <ul>
        {page.cases.map((refundCase) => (
          <li>
            <strong>{PAYMENT_PROVIDERS[refundCase.provider].label}</strong>
            {` · ${formatCurrency(refundCase.captured.amount)}`}
            {` · ${stateLabel(refundCase.state)} · `}
            <WritableLink href={`${CASE_PATH}/${refundCase.id}`}>
              {t("privacy.refunds.open", { id: refundCase.id })}
            </WritableLink>
          </li>
        ))}
      </ul>
      {page.nextCursor !== null && (
        <p>
          <a
            href={`/admin/privacy?refund_after=${encodeURIComponent(
              page.nextCursor,
            )}`}
            rel="next"
          >
            {t("privacy.refunds.next")}
          </a>
        </p>
      )}
    </section>
  );

type Choice = {
  readonly label: string;
  readonly value: string;
};

type RefundCaseFormSchema = {
  readonly danger: boolean;
  readonly id: string;
  readonly submit: string;
} & (
  | {
      readonly choices: readonly Choice[];
      readonly kind: "choices";
      readonly legend: string;
    }
  | { readonly choice: "check_again"; readonly kind: "check" }
);

const checkForm = (
  id: string,
  submit: string,
  danger: boolean,
): RefundCaseFormSchema => ({
  choice: "check_again",
  danger,
  id,
  kind: "check",
  submit,
});

const REFUND_CASE_FORMS = {
  completed: {
    choices: [
      {
        label: "privacy.refunds.recorded_choice",
        value: "money_recorded",
      },
    ],
    danger: false,
    id: "refund-recorded",
    kind: "choices",
    legend: "privacy.refunds.recorded_legend",
    submit: "privacy.refunds.recorded_submit",
  },
  needs_owner_choice: {
    choices: [
      {
        label: "privacy.refunds.choice_returned",
        value: "provider_confirmed_returned",
      },
      {
        label: "privacy.refunds.choice_not_sent",
        value: "provider_confirmed_not_sent",
      },
    ],
    danger: true,
    id: "refund-recovery",
    kind: "choices",
    legend: "privacy.refunds.choice_legend",
    submit: "privacy.refunds.submit",
  },
  observing: checkForm(
    "refund-check-observing",
    "privacy.refunds.check_again",
    false,
  ),
  ready: checkForm("refund-send-ready", "privacy.refunds.send_ready", true),
  send_armed: checkForm(
    "refund-check-armed",
    "privacy.refunds.check_again",
    false,
  ),
} as const satisfies Record<ProviderRefundCase["state"], RefundCaseFormSchema>;

const RefundCaseForm = ({
  refundCase,
}: {
  refundCase: ProviderRefundCase;
}): JSX.Element => {
  const form = REFUND_CASE_FORMS[refundCase.state];
  return (
    <WritableOnly>
      <CsrfForm action={`${CASE_PATH}/${refundCase.id}`} id={form.id}>
        <input name="revision" type="hidden" value={refundCase.revision} />
        {form.kind === "check" ? (
          <input name="choice" type="hidden" value={form.choice} />
        ) : (
          <fieldset class="radios">
            <legend>{t(form.legend)}</legend>
            {form.choices.map((choice) => (
              <RadioOption
                checked={false}
                name="choice"
                required
                value={choice.value}
              >
                {t(choice.label)}
              </RadioOption>
            ))}
          </fieldset>
        )}
        <p class="actions">
          <button class={form.danger ? "danger" : undefined} type="submit">
            {t(form.submit)}
          </button>
        </p>
      </CsrfForm>
    </WritableOnly>
  );
};

/** One refund decision. Loading this page opens exactly its one owner-sealed
 * provider reference; the queue above stays blind. */
export const adminProviderRefundCasePage = (
  session: AdminSession,
  refundCase: ProviderRefundCase,
  flash: FlashFields,
): string =>
  renderAdminPage(
    "/admin/privacy",
    session,
    t("privacy.refunds.detail_title", { id: refundCase.id }),
    <>
      <Flash error={flash.error} info={flash.info} success={flash.success} />
      <div class="prose">
        <p>
          <a href="/admin/privacy">← {t("common.back")}</a>
        </p>
        <dl>
          <dt>{t("privacy.refunds.provider")}</dt>
          <dd>{PAYMENT_PROVIDERS[refundCase.provider].label}</dd>
          <dt>{t("privacy.refunds.reference")}</dt>
          <dd>{refundCase.reference.reference}</dd>
          <dt>{t("privacy.refunds.amount")}</dt>
          <dd>{formatCurrency(refundCase.captured.amount)}</dd>
          <dt>{t("common.status")}</dt>
          <dd>{stateLabel(refundCase.state)}</dd>
          {refundCase.reason !== null && (
            <>
              <dt>{t("privacy.refunds.reason")}</dt>
              <dd>{t(REASON_LABELS[refundCase.reason])}</dd>
            </>
          )}
        </dl>
        <p>{t(STATE_EXPLANATIONS[refundCase.state])}</p>
        <RefundCaseForm refundCase={refundCase} />
      </div>
    </>,
  );
