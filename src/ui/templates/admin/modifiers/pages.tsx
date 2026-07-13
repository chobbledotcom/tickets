/**
 * The modifier admin pages: list, create, edit, and delete. The edit page wires
 * together the running-totals, revenue-adjust, ledger, and link-editor sections.
 */

import { t } from "#i18n";
import { adminDestinationAllowed, adminPath } from "#shared/admin-surface.ts";
import { formatCurrency } from "#shared/currency.ts";
import type { ModifierRow } from "#shared/db/modifiers.ts";
import { isReadOnly } from "#shared/env.ts";
import { CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, Modifier } from "#shared/types.ts";
import { AdminPage, flashFormPage } from "#templates/admin/admin-page.tsx";
import { entityDeletePage } from "#templates/admin/confirm-page.tsx";
import {
  type AccountLedgerData,
  EmbeddedAccountStatementSection,
} from "#templates/admin/ledger/statement.tsx";
import { AdminListPage } from "#templates/admin/list-page.tsx";
import { MoneyAdjustSection } from "#templates/admin/money-adjust-section.tsx";
import {
  GuideFooter,
  SaveChangesButton,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { CollectionTable } from "#templates/components/data-table.tsx";
import { getModifierFields } from "#templates/fields/modifier.ts";
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

/** Render the modifier form inputs, building the field list once and threading
 * it through both the value map and the renderer so a single page render does
 * not reconstruct the fields (and re-run their picklist i18n) twice. */
const renderModifierFormFields = (modifier?: Modifier): string => {
  const fields = getModifierFields();
  return renderFields(fields, modifierToFieldValues(modifier, fields));
};

/** The modifier guide link, rendered at the bottom of every modifier page. */
const ModifiersGuideFooter = (): JSX.Element => (
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

/** Admin modifiers list page */
export const adminModifiersPage = (
  modifiers: Modifier[],
  session: AdminSession,
  successMessage?: string,
): string =>
  AdminListPage({
    active: "/admin/modifiers",
    children: (
      <>
        <CollectionTable
          columns={[
            { header: t("common.name") },
            { header: t("modifiers.rule_column") },
            { class: "quantity", header: t("modifiers.uses_column") },
            { class: "quantity", header: t("modifiers.orders_column") },
            { class: "amount", header: t("modifiers.revenue_column") },
          ]}
          emptyKey="modifiers.no_modifiers"
          items={modifiers}
          rows={modifiers.map((m) => [
            adminDestinationAllowed(
              "modifierEdit",
              session.adminLevel,
              isReadOnly(),
            ) ? (
              <a href={adminPath("modifierEdit", { id: m.id })}>{m.name}</a>
            ) : (
              m.name
            ),
            ruleSummary(m),
            m.total_uses,
            m.usage_count,
            formatCurrency(m.total_revenue),
          ])}
        />
        <ModifiersGuideFooter />
      </>
    ),
    session,
    successMessage,
    title: t("terms.modifiers"),
  });

/** Admin modifier create page */
export const adminModifierNewPage = flashFormPage(
  "modifiers.add.heading",
  "/admin/modifiers/new",
  () => (
    <>
      <CsrfForm action="/admin/modifiers">
        <h1>{t("modifiers.add.heading")}</h1>
        <Raw html={renderModifierFormFields()} />
        <SubmitButton icon="plus">{t("modifiers.add.submit")}</SubmitButton>
      </CsrfForm>
      <ModifiersGuideFooter />
    </>
  ),
);

/** Admin modifier edit page. `links` carries the scope editor for a
 * listing/group-scoped modifier (null for a whole-order modifier);
 * `answerLinks` carries the answer editor for an "answer"-triggered modifier
 * (null otherwise). The two editors are independent — an answer modifier can
 * also be scoped to specific listings. */
export const adminModifierEditPage = (
  modifier: Modifier,
  session: AdminSession,
  error?: string,
  links?: ScopeLinks | null,
  success?: string,
  answerLinks?: AnswerLinks | null,
  ledger?: AccountLedgerData,
): string =>
  String(
    <AdminPage
      active={{ section: "/admin/modifiers" }}
      session={session}
      title={t("modifiers.edit.heading")}
    >
      <CsrfForm action={`/admin/modifiers/${modifier.id}/edit`}>
        <h1>{t("modifiers.edit.heading")}</h1>
        <Flash error={error} success={success} />
        <Raw html={renderModifierFormFields(modifier)} />
        <ModifierRunningTotalsSection modifier={modifier} />
        {SaveChangesButton()}
      </CsrfForm>
      <ModifierRevenueAdjustSection modifier={modifier} />
      {ledger && <ModifierLedgerSection ledger={ledger} />}
      {links && <ScopeLinksForm links={links} modifier={modifier} />}
      {answerLinks && (
        <AnswerLinksForm answerLinks={answerLinks} modifier={modifier} />
      )}
      <p class="actions">
        <a class="danger" href={`/admin/modifiers/${modifier.id}/delete`}>
          {t("modifiers.delete.submit")}
        </a>
      </p>
      <ModifiersGuideFooter />
    </AdminPage>,
  );

/** Admin modifier delete confirmation page. Takes the stored {@link ModifierRow}
 * (the projected total_revenue isn't shown here), so it pairs with the CRUD
 * delete loader's `table.findById`. */
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
