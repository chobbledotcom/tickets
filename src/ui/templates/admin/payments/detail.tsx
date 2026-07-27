/* jscpd:ignore-start -- imports */
import { t } from "#i18n";
import type { PaymentCasePageData } from "#routes/admin/payments/data.ts";
import { createPaymentDecisionForm } from "#routes/admin/payments/form.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import type {
  PaymentCaseDecision,
  PaymentCharge,
} from "#shared/db/payments/types.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { hasActivePaymentDecision } from "#shared/payment-runtime/operator-context.ts";
import type { AdminSession } from "#shared/types.ts";
import { type FlashOpts, flashOptsPage } from "#templates/admin/admin-page.tsx";
import type { DetailRow } from "#templates/admin/detail-rows.tsx";
import {
  formatPaymentMoney,
  paymentCaseEvidence,
  paymentCaseProvider,
  paymentCaseReason,
  paymentCaseResourceRole,
} from "#templates/admin/payments/format.tsx";
import { FormSections } from "#templates/components/aggregate-sections.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";

/* jscpd:ignore-end */

const currentCharges = (data: PaymentCasePageData): PaymentCharge[] =>
  data.context.charges.flatMap((charge) =>
    "captured" in charge ? [charge] : [],
  );

const sumMoney = (
  charges: PaymentCharge[],
  field: "captured" | "refunded",
): string => {
  const first = charges[0]?.[field];
  if (first === undefined) return t("admin.payments.money.unknown");
  const sameCurrency = charges.every(
    (charge) => charge[field].currency === first.currency,
  );
  if (!sameCurrency) return t("admin.payments.money.mixed");
  return formatPaymentMoney({
    amount: charges.reduce((total, charge) => total + charge[field].amount, 0),
    currency: first.currency,
  });
};

const paymentRows = (data: PaymentCasePageData): DetailRow[] => {
  const { context } = data;
  const charges = currentCharges(data);
  const expected =
    context.payment.origin === "current"
      ? formatPaymentMoney(context.payment.value.expected)
      : t("admin.payments.money.unknown");
  return [
    {
      key: t("admin.payments.provider"),
      value: paymentCaseProvider(context.case),
    },
    {
      key: t("admin.payments.resource"),
      value: paymentCaseResourceRole(context.case),
    },
    { key: t("admin.payments.expected"), value: expected },
    { key: t("admin.payments.captured"), value: sumMoney(charges, "captured") },
    { key: t("admin.payments.refunded"), value: sumMoney(charges, "refunded") },
    {
      key: t("admin.payments.first_seen"),
      value: formatDatetimeShort(
        new Date(context.case.firstObservedAt).toISOString(),
      ),
    },
    {
      key: t("admin.payments.last_seen"),
      value: formatDatetimeShort(
        new Date(context.case.lastObservedAt).toISOString(),
      ),
    },
  ];
};

const linkedRecords = (data: PaymentCasePageData): JSX.Element | null => {
  if (data.attendee === null && data.listings.length === 0) return null;
  return (
    <section>
      <h2>{t("admin.payments.booking")}</h2>
      <ul>
        {data.attendee !== null && (
          <li>
            <a href={`/admin/attendees/${data.attendee.id}`}>
              {data.attendee.name}
            </a>
          </li>
        )}
        {data.listings.map((listing) => (
          <li>
            <a href={`/admin/listing/${listing.id}`}>{listing.name}</a>
          </li>
        ))}
      </ul>
    </section>
  );
};

const retryDecision = (
  data: PaymentCasePageData,
  decision: PaymentCaseDecision,
): JSX.Element | null => {
  // The database only lets a decision be retrying when it has a due time, so
  // no due time means there is nothing waiting to run.
  const dueAt = decision.state === "retrying" ? decision.nextRetryAt : null;
  if (dueAt === null) return null;
  return (
    <>
      <p>
        {t("admin.payments.decision_next_retry", {
          date: formatDatetimeShort(new Date(dueAt).toISOString()),
        })}
      </p>
      {dueAt <= Date.now() && (
        <SaveForm
          action={`${adminPath("paymentCase", { caseId: data.context.case.id })}/retry/${decision.id}`}
          submitIcon="rotate-ccw"
          submitLabel={t("admin.payments.retry_saved")}
        />
      )}
    </>
  );
};

const retryHistory = (data: PaymentCasePageData): JSX.Element => (
  <section>
    <h2>{t("admin.payments.retry_history")}</h2>
    <p>
      {t("admin.payments.observations", {
        count: data.context.case.consecutiveCount,
      })}
    </p>
    {data.context.case.nextReconcileAt !== null && (
      <p>
        {t("admin.payments.next_retry", {
          date: formatDatetimeShort(
            new Date(data.context.case.nextReconcileAt).toISOString(),
          ),
        })}
      </p>
    )}
    {data.context.decisions.map((decision) => (
      <div>
        <p>
          {t("admin.payments.decision_attempts", {
            count: decision.attemptCount,
            state: t(`admin.payments.decision_state.${decision.state}`),
          })}
        </p>
        {retryDecision(data, decision)}
      </div>
    ))}
  </section>
);

const decisionForm = (data: PaymentCasePageData): JSX.Element | null => {
  const form = createPaymentDecisionForm(data.context, data.accounts);
  if (form.fields[0].options.length === 1) {
    return <p>{t("admin.payments.no_safe_decision")}</p>;
  }
  return (
    <section>
      <h2>{t("admin.payments.choose_heading")}</h2>
      <p class="warning">{t("admin.payments.irreversible_warning")}</p>
      <SaveForm
        action={adminPath("paymentCase", { caseId: data.context.case.id })}
        submitIcon="check"
        submitLabel={t("admin.payments.submit")}
      >
        <FormSections
          sections={[
            {
              children: (
                <Raw
                  html={`${form.renderField("decision")}${form.renderField(
                    "case_revision",
                    String(data.context.case.revision),
                  )}`}
                />
              ),
              legend: t("admin.payments.decision_section"),
            },
            {
              children: <Raw html={form.renderField("reason")} />,
              legend: t("admin.payments.reason_section"),
            },
          ]}
        />
      </SaveForm>
    </section>
  );
};

export const adminPaymentCasePage = (
  data: PaymentCasePageData,
  session: AdminSession,
  notices: FlashOpts = {},
): string => {
  const title = t("admin.payments.case", { id: data.context.case.id });
  return flashOptsPage(title, "/admin/payments")(session, notices)(
    <>
      <h1>{title}</h1>
      <p>{paymentCaseReason(data.context.case.reason)}</p>
      <DetailTable rows={paymentRows(data)} />
      <section>
        <h2>{t("admin.payments.evidence.heading")}</h2>
        <p>{paymentCaseEvidence(data.context.case)}</p>
      </section>
      {linkedRecords(data)}
      {retryHistory(data)}
      {data.context.case.state === "needs_action" &&
        !hasActivePaymentDecision(data.context) &&
        decisionForm(data)}
    </>,
  );
};
