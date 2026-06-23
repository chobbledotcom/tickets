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
import { isReadOnly } from "#shared/env.ts";
import {
  booleanToCheckbox,
  ConfirmForm,
  CsrfForm,
  entityToFieldValues,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, Modifier } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  adminRecalculatePage,
  type RecalculateRow,
} from "#templates/admin/recalculate.tsx";
import {
  ActionButton,
  GuideLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { colClass } from "#templates/components/table-columns.ts";
import { modifierAggregateFields, modifierFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** Candidate listings/groups and current links for the scope editor. */
export type ScopeLinks = {
  kind: "listings" | "groups";
  options: { id: number; name: string }[];
  selected: number[];
};

/** Candidate answers and current links for an "answer"-triggered modifier.
 * Options are flattened across questions; each name reads "Question — Answer". */
export type AnswerLinks = {
  options: { id: number; name: string }[];
  selected: number[];
};

/** The listing/group link editor shown on the edit page for a scoped modifier. */
const ScopeLinksForm = ({
  modifier,
  links,
}: {
  modifier: Modifier;
  links: ScopeLinks;
}): JSX.Element => {
  const field = links.kind === "listings" ? "listing_ids" : "group_ids";
  const heading =
    links.kind === "listings"
      ? t("modifiers.scope.listings_heading")
      : t("modifiers.scope.groups_heading");
  return (
    <CsrfForm action={`/admin/modifiers/${modifier.id}/links`}>
      <h2>{heading}</h2>
      {links.options.length === 0 ? (
        <p>{t("modifiers.scope.none")}</p>
      ) : (
        <fieldset class="checkboxes">
          {links.options.map((o) => (
            <label>
              <input
                checked={links.selected.includes(o.id) || undefined}
                name={field}
                type="checkbox"
                value={String(o.id)}
              />
              {` ${o.name}`}
            </label>
          ))}
        </fieldset>
      )}
      <SubmitButton icon="save">{t("modifiers.scope.save")}</SubmitButton>
    </CsrfForm>
  );
};

/** The answer link editor shown on the edit page for an "answer"-triggered
 * modifier: tick the question answers that apply this modifier. */
const AnswerLinksForm = ({
  modifier,
  answerLinks,
}: {
  modifier: Modifier;
  answerLinks: AnswerLinks;
}): JSX.Element => (
  <CsrfForm action={`/admin/modifiers/${modifier.id}/answers`}>
    <h2>{t("modifiers.answers.heading")}</h2>
    <p>
      <small>{t("modifiers.answers.hint")}</small>
    </p>
    {answerLinks.options.length === 0 ? (
      <p>{t("modifiers.answers.none")}</p>
    ) : (
      <fieldset class="checkboxes">
        {answerLinks.options.map((o) => (
          <label>
            <input
              checked={answerLinks.selected.includes(o.id) || undefined}
              name="answer_ids"
              type="checkbox"
              value={String(o.id)}
            />
            {` ${o.name}`}
          </label>
        ))}
      </fieldset>
    )}
    <SubmitButton icon="save">{t("modifiers.answers.save")}</SubmitButton>
  </CsrfForm>
);

/** Human-readable summary of a modifier's rule, e.g. "Discount · 10%". */
const ruleSummary = (m: Modifier): string => {
  const value = String(m.calc_value);
  if (m.calc_kind === "multiply")
    return t("modifiers.rule.multiply", { value });
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

/**
 * Money-correction section for a modifier, kept separate from the counts override
 * ("splits by kind", decision 14). Shows the current projected revenue
 * (read-only) and an input for the corrected value; submitting posts a `writeoff`
 * adjustment for the difference to the source-of-truth money ledger. A prominent
 * warning states the entry is appended, not destructive. Its own CsrfForm, so it
 * posts independently of the main edit form.
 */
const ModifierRevenueAdjustSection = ({
  modifier,
}: {
  modifier: Modifier;
}): JSX.Element => (
  <CsrfForm action={`/admin/modifiers/${modifier.id}/revenue`}>
    <h2>{t("modifiers.adjust_revenue")}</h2>
    <div class="error" role="alert">
      {t("modifiers.adjust_revenue_warning")}
    </div>
    <label>
      {t("modifiers.adjust_revenue_current")}
      <input
        disabled
        type="text"
        value={formatCurrency(modifier.total_revenue)}
      />
    </label>
    <label for="total_revenue">
      {t("modifiers.adjust_revenue_new_label")}
      <input
        id="total_revenue"
        inputmode="decimal"
        name="total_revenue"
        step="0.01"
        type="number"
        value={toMajorUnits(modifier.total_revenue)}
      />
    </label>
    <SubmitButton icon="save">
      {t("modifiers.adjust_revenue_submit")}
    </SubmitButton>
  </CsrfForm>
);

const ModifierRunningTotalsSection = ({
  modifier,
}: {
  modifier: Modifier;
}): JSX.Element => (
  <fieldset>
    <legend>{t("modifiers.running_totals")}</legend>
    <p>
      <small>{t("modifiers.running_totals_note")}</small>
    </p>
    <Raw
      html={renderFields(
        modifierAggregateFields,
        modifierAggregateToFieldValues(modifier),
      )}
    />
    <p>
      <a href={`/admin/modifiers/recalculate/${modifier.id}`}>
        {t("modifiers.recalculate_totals")}
      </a>
    </p>
  </fieldset>
);

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
  adminRecalculatePage({
    action: `/admin/modifiers/recalculate/${modifier.id}`,
    active: "/admin/modifiers",
    currentLabel: t("modifiers.recalculate.current"),
    description: t("modifiers.recalculate.description"),
    error,
    recalculatedLabel: t("modifiers.recalculate.from_attendees"),
    rows: modifierRecalculateRows(snapshot),
    session,
    submitLabel: t("modifiers.recalculate.save"),
    success,
    title: t("modifiers.recalculate.heading", { name: modifier.name }),
  });

/** Admin modifiers list page */
export const adminModifiersPage = (
  modifiers: Modifier[],
  session: AdminSession,
  successMessage?: string,
): string =>
  String(
    <Layout title={t("terms.modifiers")}>
      <AdminNav active="/admin/modifiers" session={session} />
      <Flash success={successMessage} />
      <p class="actions">
        {!isReadOnly() && (
          <ActionButton href="/admin/modifiers/new" icon="plus">
            {t("modifiers.add_modifier")}
          </ActionButton>
        )}
        <GuideLink href="/admin/guide#modifiers">
          {t("modifiers.guide_link")}
        </GuideLink>
      </p>
      {modifiers.length === 0 ? (
        <p>{t("modifiers.no_modifiers")}</p>
      ) : (
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("common.name")}</th>
                <th>{t("modifiers.rule_column")}</th>
                <th class={colClass("quantity")}>
                  {t("modifiers.uses_column")}
                </th>
                <th class={colClass("quantity")}>
                  {t("modifiers.orders_column")}
                </th>
                <th class={colClass("amount")}>
                  {t("modifiers.revenue_column")}
                </th>
              </tr>
            </thead>
            <tbody>
              {modifiers.map((m) => (
                <tr>
                  <td>
                    <a href={`/admin/modifiers/${m.id}/edit`}>{m.name}</a>
                  </td>
                  <td>{ruleSummary(m)}</td>
                  <td class={colClass("quantity")}>{m.total_uses}</td>
                  <td class={colClass("quantity")}>{m.usage_count}</td>
                  <td class={colClass("amount")}>
                    {formatCurrency(m.total_revenue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>,
  );

/** Admin modifier create page */
export const adminModifierNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("modifiers.add.heading")}>
      <AdminNav active="/admin/modifiers" session={session} />
      <CsrfForm action="/admin/modifiers">
        <h1>{t("modifiers.add.heading")}</h1>
        <p class="actions">
          <GuideLink href="/admin/guide#modifiers">
            {t("modifiers.guide_link")}
          </GuideLink>
        </p>
        <Flash error={error} />
        <Raw html={renderFields(modifierFields, modifierToFieldValues())} />
        <SubmitButton icon="plus">{t("modifiers.add.submit")}</SubmitButton>
      </CsrfForm>
    </Layout>,
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
): string =>
  String(
    <Layout title={t("modifiers.edit.heading")}>
      <AdminNav active="/admin/modifiers" session={session} />
      <CsrfForm action={`/admin/modifiers/${modifier.id}/edit`}>
        <h1>{t("modifiers.edit.heading")}</h1>
        <p class="actions">
          <GuideLink href="/admin/guide#modifiers">
            {t("modifiers.guide_link")}
          </GuideLink>
        </p>
        <Flash error={error} success={success} />
        <Raw
          html={renderFields(modifierFields, modifierToFieldValues(modifier))}
        />
        <ModifierRunningTotalsSection modifier={modifier} />
        <SubmitButton icon="save">{t("common.save_changes")}</SubmitButton>
      </CsrfForm>
      <ModifierRevenueAdjustSection modifier={modifier} />
      {links && <ScopeLinksForm links={links} modifier={modifier} />}
      {answerLinks && (
        <AnswerLinksForm answerLinks={answerLinks} modifier={modifier} />
      )}
      <p class="actions">
        <a class="danger" href={`/admin/modifiers/${modifier.id}/delete`}>
          {t("modifiers.delete.submit")}
        </a>
      </p>
    </Layout>,
  );

/** Admin modifier delete confirmation page. Takes the stored {@link ModifierRow}
 * (the projected total_revenue isn't shown here), so it pairs with the CRUD
 * delete loader's `table.findById`. */
export const adminModifierDeletePage = (
  modifier: ModifierRow,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("modifiers.delete.heading")}>
      <AdminNav active="/admin/modifiers" session={session} />
      <ConfirmForm
        action={`/admin/modifiers/${modifier.id}/delete`}
        buttonText={t("modifiers.delete.submit")}
        danger={false}
        label={t("modifiers.name_label")}
        name={modifier.name}
      >
        <h1>{t("modifiers.delete.heading")}</h1>
        <Flash error={error} />
        <p>{t("modifiers.delete.confirm", { name: modifier.name })}</p>
        <p>{t("modifiers.delete.confirm_prompt")}</p>
      </ConfirmForm>
    </Layout>,
  );
