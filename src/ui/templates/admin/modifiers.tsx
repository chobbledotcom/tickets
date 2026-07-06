/**
 * Admin price-modifier management page templates
 */

import { t } from "#i18n";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import type {
  ModifierAggregateField,
  ModifierAggregateRecalculation,
  ModifierRow,
} from "#shared/db/modifiers.ts";
import {
  booleanToCheckbox,
  CsrfForm,
  entityToFieldValues,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, Modifier } from "#shared/types.ts";
import { AdminPage, errorAdminPage } from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import {
  type AccountLedgerData,
  EmbeddedAccountStatementSection,
} from "#templates/admin/ledger.tsx";
import { AdminListPage } from "#templates/admin/list-page.tsx";
import { MoneyAdjustSection } from "#templates/admin/money-adjust-section.tsx";
import type { RecalculateRow } from "#templates/admin/recalculate.tsx";
import {
  GuideFooter,
  SaveChangesButton,
  SubmitButton,
} from "#templates/components/actions.tsx";
import {
  type RunningTotalsConfig,
  RunningTotalsFieldset,
  recalculatePageRenderer,
} from "#templates/components/aggregate-sections.tsx";
import { DataTable } from "#templates/components/data-table.tsx";
import {
  LinkedItemsCheckboxes,
  toLinkedItemOptions,
} from "#templates/components/linked-items.tsx";
import { modifierAggregateFields, modifierFields } from "#templates/fields.ts";

/** Renders the static config bits of the modifier recalculate page (action,
 *  labels, rows). The exported `adminModifierRecalculatePage` then binds the
 *  per-request `(session, error?, success?)` to it. */
const modifierRecalculateRenderer = (
  modifier: Modifier,
  snapshot: ModifierAggregateRecalculation,
) =>
  recalculatePageRenderer({
    action: `/admin/modifiers/recalculate/${modifier.id}`,
    active: "/admin/modifiers",
    currentLabel: t("modifiers.recalculate.current"),
    description: t("modifiers.recalculate.description"),
    recalculatedLabel: t("modifiers.recalculate.from_attendees"),
    rows: modifierRecalculateRows(snapshot),
    submitLabel: t("modifiers.recalculate.save"),
    title: t("modifiers.recalculate.heading", { name: modifier.name }),
  });

/** Each linkable scope kind → the form field its checkboxes post under and the
 * term key for its plural type name. Adding a scope kind is one self-contained
 * entry here; the ScopeLinkKind union and both the field name and heading follow
 * from this table, so there are no per-kind ternaries to keep in sync. */
export const SCOPE_LINK_KINDS = {
  groups: { field: "group_ids", term: "terms.groups" },
  listings: { field: "listing_ids", term: "terms.listings" },
} as const satisfies Record<string, { field: string; term: string }>;

export type ScopeLinkKind = keyof typeof SCOPE_LINK_KINDS;

/** Candidate listings/groups and current links for the scope editor.
 * Listings carry their active flag (a deactivated one renders muted); groups
 * have no deactivated state, so they arrive already active. */
export type ScopeLinks = {
  kind: ScopeLinkKind;
  options: { id: number; name: string; active: boolean }[];
  selected: number[];
};

/** Candidate answers and current links for an "answer"-triggered modifier.
 * Options are flattened across questions; each name reads "Question — Answer". */
export type AnswerLinks = {
  options: { id: number; name: string }[];
  selected: number[];
};

/** The modifier guide link, rendered at the bottom of every modifier page. */
const ModifiersGuideFooter = (): JSX.Element => (
  <GuideFooter href="/admin/guide#modifiers">
    {t("modifiers.guide_link")}
  </GuideFooter>
);

/** The listing/group link editor shown on the edit page for a scoped modifier. */
const ScopeLinksForm = ({
  modifier,
  links,
}: {
  modifier: Modifier;
  links: ScopeLinks;
}): JSX.Element => {
  const { field, term } = SCOPE_LINK_KINDS[links.kind];
  return (
    <CsrfForm action={`/admin/modifiers/${modifier.id}/links`}>
      {links.options.length === 0 ? (
        <p>{t("modifiers.scope.none")}</p>
      ) : (
        <LinkedItemsCheckboxes
          groups={[
            {
              label: t(term),
              options: toLinkedItemOptions(links.options, links.selected),
            },
          ]}
          name={field}
        />
      )}
      <SubmitButton icon="save">{t("modifiers.scope.save")}</SubmitButton>
    </CsrfForm>
  );
};

/** The answer link editor shown on the edit page for an "answer"-triggered
 *  modifier: tick the question answers that apply this modifier. Answers have
 *  no deactivated state, so every option arrives active. */
const AnswerLinksForm = ({
  modifier,
  answerLinks,
}: {
  modifier: Modifier;
  answerLinks: AnswerLinks;
}): JSX.Element => (
  <CsrfForm action={`/admin/modifiers/${modifier.id}/answers`}>
    <p>
      <small>{t("modifiers.answers.hint")}</small>
    </p>
    {answerLinks.options.length === 0 ? (
      <p>{t("modifiers.answers.none")}</p>
    ) : (
      <LinkedItemsCheckboxes
        groups={[
          {
            label: t("terms.answers"),
            options: toLinkedItemOptions(
              answerLinks.options.map((option) => ({
                ...option,
                active: true,
              })),
              answerLinks.selected,
            ),
          },
        ]}
        name="answer_ids"
      />
    )}
    <SubmitButton icon="save">{t("modifiers.answers.save")}</SubmitButton>
  </CsrfForm>
);

/** Human-readable summary of a modifier's rule, e.g. "Discount · 10%". */
const ruleSummary = (m: Modifier): string => {
  const value = String(m.calc_value);
  if (m.calc_kind === "multiply") {
    return t("modifiers.rule.multiply", { value });
  }
  const action = t(
    m.direction === "discount"
      ? "modifiers.action.discount"
      : "modifiers.action.charge",
  );
  return t(
    m.calc_kind === "percent"
      ? "modifiers.rule.percent"
      : "modifiers.rule.fixed",
    { action, value },
  );
};

/** Pre-fill form values from a modifier; new modifiers default to active. */
export const modifierToFieldValues = (
  modifier?: Modifier,
): Record<string, string | number | null> =>
  entityToFieldValues(
    modifier,
    modifierFields,
    {
      active: (m) => booleanToCheckbox(m.active),
      min_subtotal: (m) =>
        m.min_subtotal ? Number(toMajorUnits(m.min_subtotal)) : "",
      min_visits: (m) => m.min_visits || "",
      stock: (m) => m.stock ?? "",
    },
    modifier ? undefined : { active: "1" },
  );

export const modifierAggregateToFieldValues = (
  modifier: Modifier,
): Record<string, string | number> => ({
  total_uses: modifier.total_uses,
  usage_count: modifier.usage_count,
});

const ModifierRevenueAdjustSection = ({
  modifier,
}: {
  modifier: Modifier;
}): JSX.Element => (
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

const ModifierRunningTotalsSection = ({
  modifier,
}: {
  modifier: Modifier;
}): JSX.Element =>
  RunningTotalsFieldset({
    config: modifierRunningTotalsConfig(modifier),
  });

const modifierRunningTotalsConfig = (
  modifier: Modifier,
): RunningTotalsConfig => ({
  fields: modifierAggregateFields,
  legend: t("modifiers.running_totals"),
  note: t("modifiers.running_totals_note"),
  recalculateHref: `/admin/modifiers/recalculate/${modifier.id}`,
  recalculateLabel: t("modifiers.recalculate_totals"),
  values: modifierAggregateToFieldValues(modifier),
});

const modifierAggregateFormatters: Record<
  ModifierAggregateField,
  (value: number) => string
> = {
  total_uses: String,
  usage_count: String,
};

const modifierRecalculateRows = (
  snapshot: ModifierAggregateRecalculation,
): RecalculateRow[] =>
  modifierAggregateFields.map((field) => {
    const name = field.name as ModifierAggregateField;
    return {
      current: modifierAggregateFormatters[name](snapshot[name].current),
      label: field.label,
      name,
      recalculated: modifierAggregateFormatters[name](
        snapshot[name].recalculated,
      ),
    };
  });

export const adminModifierRecalculatePage = (
  modifier: Modifier,
  snapshot: ModifierAggregateRecalculation,
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  modifierRecalculateRenderer(modifier, snapshot)(session, error, success);

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
        {modifiers.length === 0 ? (
          <p>{t("modifiers.no_modifiers")}</p>
        ) : (
          <DataTable
            columns={[
              { header: t("common.name") },
              { header: t("modifiers.rule_column") },
              { class: "quantity", header: t("modifiers.uses_column") },
              { class: "quantity", header: t("modifiers.orders_column") },
              { class: "amount", header: t("modifiers.revenue_column") },
            ]}
            rows={modifiers.map((m) => [
              <a href={`/admin/modifiers/${m.id}/edit`}>{m.name}</a>,
              ruleSummary(m),
              m.total_uses,
              m.usage_count,
              formatCurrency(m.total_revenue),
            ])}
          />
        )}
        <ModifiersGuideFooter />
      </>
    ),
    session,
    successMessage,
    title: t("terms.modifiers"),
  });

/** Admin modifier create page */
export const adminModifierNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  errorAdminPage(t("modifiers.add.heading"), "/admin/modifiers/new")(
    session,
    error,
  )(
    <>
      <CsrfForm action="/admin/modifiers">
        <h1>{t("modifiers.add.heading")}</h1>
        <Raw html={renderFields(modifierFields, modifierToFieldValues())} />
        <SubmitButton icon="plus">{t("modifiers.add.submit")}</SubmitButton>
      </CsrfForm>
      <ModifiersGuideFooter />
    </>,
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
      active="/admin/modifiers"
      session={session}
      title={t("modifiers.edit.heading")}
    >
      <CsrfForm action={`/admin/modifiers/${modifier.id}/edit`}>
        <h1>{t("modifiers.edit.heading")}</h1>
        <Flash error={error} success={success} />
        <Raw
          html={renderFields(modifierFields, modifierToFieldValues(modifier))}
        />
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
export const adminModifierDeletePage = (
  modifier: ModifierRow,
  session: AdminSession,
  error?: string,
): string =>
  ConfirmPage({
    action: `/admin/modifiers/${modifier.id}/delete`,
    active: "/admin/modifiers",
    buttonText: t("modifiers.delete.submit"),
    children: (
      <>
        <h1>{t("modifiers.delete.heading")}</h1>
        <p>{t("modifiers.delete.confirm", { name: modifier.name })}</p>
        <p>{t("modifiers.delete.confirm_prompt")}</p>
      </>
    ),
    danger: false,
    error,
    label: t("modifiers.name_label"),
    name: modifier.name,
    session,
    title: t("modifiers.delete.heading"),
  });
