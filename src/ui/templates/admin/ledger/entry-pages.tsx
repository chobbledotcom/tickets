/* jscpd:ignore-start */
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { hiddenInputs } from "#shared/forms/hidden-inputs.tsx";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";
import type { AdminSession } from "#shared/types.ts";
import { errorAdminPage } from "#templates/admin/admin-page.tsx";
import {
  defineLedgerEntryAddForm,
  type LedgerEntryAddOption,
  ledgerEntryForm,
} from "#templates/admin/ledger/entry-form.ts";
import { humanDescription } from "#templates/admin/ledger/formatting.tsx";
import {
  accountCellFor,
  accountLabelText,
  type LedgerNames,
} from "#templates/admin/ledger.tsx";
import { ActionButton, SubmitButton } from "#templates/components/actions.tsx";
import { ConfirmForm } from "#templates/components/save-form.tsx";

/* jscpd:ignore-end */

type LedgerEntryFormValues = {
  amount: string;
  occurred_at: string;
  entry_type?: string;
};

type LedgerEntryPageData = {
  error?: string | undefined;
  names: LedgerNames;
  returnUrl: string;
  session: AdminSession;
  values: LedgerEntryFormValues;
};

const LedgerEntryCancel = ({
  returnUrl,
}: {
  returnUrl: string;
}): JSX.Element => (
  <p>
    <ActionButton href={returnUrl} variant="secondary">
      {t("common.cancel")}
    </ActionButton>
  </p>
);

const ledgerEntryPage = (
  headingKey: string,
  session: AdminSession,
  error: string | undefined,
  child: Child,
): string =>
  errorAdminPage(t(headingKey), "/admin/ledger")(session, error)(child);

const LedgerEntryForm = ({
  action,
  afterFields,
  buttonText,
  children,
  fieldsHtml,
  icon,
  returnUrl,
}: {
  action: string;
  afterFields?: Child;
  buttonText: string;
  children?: Child;
  fieldsHtml: string;
  icon: "plus" | "save";
  returnUrl: string;
}): JSX.Element => (
  <CsrfForm action={action}>
    {children}
    {hiddenInputs([["return_url", returnUrl]])}
    <Raw html={fieldsHtml} />
    <SubmitButton icon={icon}>{buttonText}</SubmitButton>
    {afterFields}
  </CsrfForm>
);

export const adminLedgerEntryAddPage = ({
  account,
  names,
  options,
  values,
  returnUrl,
  session,
  error,
}: LedgerEntryPageData & {
  account: AccountRef;
  options: LedgerEntryAddOption[];
}): string =>
  ledgerEntryPage(
    "admin.ledger.add.heading",
    session,
    error,
    <LedgerEntryForm
      action={`/admin/ledger/${account.type}/${account.id}/add`}
      afterFields={<LedgerEntryCancel returnUrl={returnUrl} />}
      buttonText={t("admin.ledger.add.submit")}
      fieldsHtml={defineLedgerEntryAddForm(options).render(values)}
      icon="plus"
      returnUrl={returnUrl}
    >
      <h1>{t("admin.ledger.add.heading")}</h1>
      <p>
        {t("admin.ledger.add.account")}{" "}
        <strong>{accountLabelText(account, names)}</strong>
      </p>
    </LedgerEntryForm>,
  );

export const adminLedgerEntryEditPage = ({
  transfer,
  names,
  values,
  returnUrl,
  session,
  error,
}: LedgerEntryPageData & {
  transfer: Transfer;
}): string =>
  ledgerEntryPage(
    "admin.ledger.edit.heading",
    session,
    error,
    <>
      <h1>{t("admin.ledger.edit.heading")}</h1>
      <p>{humanDescription(transfer, accountCellFor(names))}</p>
      <LedgerEntryForm
        action={`/admin/ledger/entries/${transfer.id}/edit`}
        buttonText={t("common.save_changes")}
        fieldsHtml={ledgerEntryForm.render(values)}
        icon="save"
        returnUrl={returnUrl}
      />
      <ConfirmForm
        action={`/admin/ledger/entries/${transfer.id}/delete`}
        buttonText={t("admin.ledger.delete.submit")}
        label={t("admin.ledger.delete.label")}
        name={formatCurrency(transfer.amount)}
        returnUrl={returnUrl}
      >
        <h2>{t("admin.ledger.delete.heading")}</h2>
        <p>{t("admin.ledger.delete.warning")}</p>
        <p>
          {t("admin.ledger.delete.confirm_prompt", {
            amount: formatCurrency(transfer.amount),
          })}
        </p>
      </ConfirmForm>
      <LedgerEntryCancel returnUrl={returnUrl} />
    </>,
  );
