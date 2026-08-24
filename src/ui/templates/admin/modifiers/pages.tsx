/* jscpd:ignore-start */

import type { ModifierRow } from "#db/modifiers.ts";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { adminDestinationAllowed, adminPath } from "#shared/admin-surface.ts";
import { formatCurrency } from "#shared/currency.ts";
import { isReadOnly } from "#shared/env.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { editPanel, flashFormPage } from "#templates/admin/admin-page.tsx";
import { entityDeletePage } from "#templates/admin/confirm-page.tsx";
import {
  type AccountLedgerData,
  EmbeddedAccountStatementSection,
} from "#templates/admin/ledger/statement.tsx";
import { AdminListPage } from "#templates/admin/list-page.tsx";
import { MoneyAdjustSection } from "#templates/admin/money-adjust-section.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { itemsOrEmptyNote } from "#templates/components/reorder-list.tsx";
import {
  SaveForm,
  saveFormComponent,
} from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import { getModifierForm } from "#templates/fields/modifier.ts";
import type { AdminSession, Modifier } from "#types";
import {
  ModifierRunningTotalsSection,
  type ModifierSectionProps,
} from "./aggregates.tsx";
import {
  type AnswerLinks,
  AnswerLinksForm,
  type ScopeLinks,
  ScopeLinksForm,
} from "./links.tsx";
import { modifierToFieldValues, ruleSummary } from "./values.ts";

/* jscpd:ignore-end */

const renderModifierFormFields = (
  modifier?: Modifier,
  values?: Record<string, string | number | null>,
): string => {
  const form = getModifierForm();
  return form.render(values ?? modifierToFieldValues(modifier, form.fields));
};

export const ModifiersGuideFooter = (): JSX.Element => (
  <GuideFooter href="/admin/guide#modifiers">
    {t("modifiers.guide_link")}
  </GuideFooter>
);

const ModifierRevenueAdjustSection = ({
  modifier,
}: ModifierSectionProps): JSX.Element => (
  <MoneyAdjustSection
    action={`/admin/modifiers/${modifier.id}/revenue`}
    currentLabel={t("modifiers.adjust_revenue_current")}
    currentValue={modifier.total_revenue}
    inputId="total_revenue"
    inputLabel={t("modifiers.adjust_revenue_new_label")}
    submitLabel={t("modifiers.adjust_revenue_submit")}
    title={t("modifiers.adjust_revenue")}
    warning={t("modifiers.adjust_revenue_warning")}
  />
);

const ModifierLedgerSection = ({
  ledger,
}: {
  ledger: AccountLedgerData;
}): JSX.Element =>
  EmbeddedAccountStatementSection({
    fullLedgerHref: `/admin/ledger/${ledger.account.type}/${ledger.account.id}`,
    ledger,
    returnUrl: `/admin/modifiers/${ledger.account.id}/edit`,
  });

type ModifierRenderValues = Record<string, string | number | null>;

interface ModifierValuesProps {
  modifier: Modifier;
  values?: ModifierRenderValues;
}

const submittedValues = (
  values: ModifierRenderValues | undefined,
): { values: ModifierRenderValues } | object => (values ? { values } : {});

const ModifierFieldsForm = saveFormComponent<
  ModifierValuesProps & {
    action: string;
  }
>(({ modifier, values }) => ({
  children: (
    <>
      <Raw html={renderModifierFormFields(modifier, values)} />
      <ModifierRunningTotalsSection
        modifier={modifier}
        {...submittedValues(values)}
      />
    </>
  ),
  submitLabel: t("common.save_changes"),
}));

const modifiersTable = defineTable<Modifier, AdminSession>([
  translatedTableColumn("name", "common.name", (modifier, session) =>
    adminDestinationAllowed(
      "modifierEdit",
      session.adminLevel,
      isReadOnly(),
    ) ? (
      <a href={adminPath("modifierEdit", { id: modifier.id })}>
        {modifier.name}
      </a>
    ) : (
      modifier.name
    ),
  ),
  {
    cell: ruleSummary,
    header: () => t("modifiers.rule_column"),
    key: "rule",
  },
  {
    cell: (modifier) => modifier.total_uses,
    class: "quantity",
    header: () => t("modifiers.uses_column"),
    key: "uses",
  },
  {
    cell: (modifier) => modifier.usage_count,
    class: "quantity",
    header: () => t("modifiers.orders_column"),
    key: "orders",
  },
  {
    cell: (modifier) => formatCurrency(modifier.total_revenue),
    class: "amount",
    header: () => t("modifiers.revenue_column"),
    key: "revenue",
  },
]);

export const adminModifiersPage = (
  modifiers: Modifier[],
  session: AdminSession,
  successMessage?: string,
): string =>
  AdminListPage({
    active: "/admin/modifiers",
    children: (
      <>
        {itemsOrEmptyNote(modifiers, t("modifiers.no_modifiers"), (rows) =>
          renderTable(modifiersTable, rows, { context: session }),
        )}
        <ModifiersGuideFooter />
      </>
    ),
    session,
    successMessage,
    title: t("terms.modifiers"),
  });

export const adminModifierNewPage = flashFormPage(
  "modifiers.add.heading",
  "/admin/modifiers/new",
  () => (
    <>
      <SaveForm
        action="/admin/modifiers"
        submitIcon="plus"
        submitLabel={t("modifiers.add.submit")}
      >
        <h1>{t("modifiers.add.heading")}</h1>
        <Raw html={renderModifierFormFields()} />
      </SaveForm>
      <ModifiersGuideFooter />
    </>
  ),
);

export const ModifierEditPanel = ({
  answerLinks,
  error,
  ledger,
  links,
  modifier,
  values,
}: ModifierValuesProps & {
  answerLinks: AnswerLinks | null;
  error?: string;
  ledger?: AccountLedgerData;
  links: ScopeLinks | null;
}): JSX.Element =>
  editPanel(error)(
    <>
      <ModifierFieldsForm
        action={`/admin/modifiers/${modifier.id}/edit`}
        modifier={modifier}
        {...submittedValues(values)}
      />
      <ModifierRevenueAdjustSection modifier={modifier} />
      {ledger && <ModifierLedgerSection ledger={ledger} />}
      {links && <ScopeLinksForm links={links} modifier={modifier} />}
      {answerLinks && (
        <AnswerLinksForm answerLinks={answerLinks} modifier={modifier} />
      )}
    </>,
  );

export const adminModifierDeletePage = entityDeletePage(
  (modifier: ModifierRow) => ({
    action: `/admin/modifiers/${modifier.id}/delete`,
    active: { section: "/admin/modifiers" },
    buttonText: t("modifiers.delete.submit"),
    children: (
      <>
        <h1>{t("modifiers.delete.heading")}</h1>
        <p>{t("modifiers.delete.confirm", { name: modifier.name })}</p>
        <p>{t("modifiers.delete.confirm_prompt")}</p>
      </>
    ),
    danger: false,
    label: t("modifiers.name_label"),
    name: modifier.name,
    title: t("modifiers.delete.heading"),
  }),
);
