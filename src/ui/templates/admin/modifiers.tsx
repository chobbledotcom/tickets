/**
 * Admin price-modifier management page templates
 */

import { t } from "#i18n";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
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
import { ActionButton, SubmitButton } from "#templates/components/actions.tsx";
import { modifierFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** Candidate listings/groups and current links for the scope editor. */
export type ScopeLinks = {
  kind: "listings" | "groups";
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
      stock: (m) => m.stock ?? "",
    },
    modifier ? undefined : { active: "1" },
  );

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
      {!isReadOnly() && (
        <p class="actions">
          <ActionButton href="/admin/modifiers/new" icon="plus">
            {t("modifiers.add_modifier")}
          </ActionButton>
        </p>
      )}
      {modifiers.length === 0 ? (
        <p>{t("modifiers.no_modifiers")}</p>
      ) : (
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("common.name")}</th>
                <th>{t("modifiers.rule_column")}</th>
                <th>{t("modifiers.uses_column")}</th>
                <th>{t("modifiers.orders_column")}</th>
                <th>{t("modifiers.revenue_column")}</th>
              </tr>
            </thead>
            <tbody>
              {modifiers.map((m) => (
                <tr>
                  <td>
                    <a href={`/admin/modifiers/${m.id}/edit`}>{m.name}</a>
                  </td>
                  <td>{ruleSummary(m)}</td>
                  <td>{m.total_uses}</td>
                  <td>{m.usage_count}</td>
                  <td>{formatCurrency(m.total_revenue)}</td>
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
        <Flash error={error} />
        <Raw html={renderFields(modifierFields, modifierToFieldValues())} />
        <SubmitButton icon="plus">{t("modifiers.add.submit")}</SubmitButton>
      </CsrfForm>
    </Layout>,
  );

/** Admin modifier edit page. `links` carries the scope editor for a
 * listing/group-scoped modifier (null for a whole-order modifier). */
export const adminModifierEditPage = (
  modifier: Modifier,
  session: AdminSession,
  error?: string,
  links?: ScopeLinks | null,
): string =>
  String(
    <Layout title={t("modifiers.edit.heading")}>
      <AdminNav active="/admin/modifiers" session={session} />
      <CsrfForm action={`/admin/modifiers/${modifier.id}/edit`}>
        <h1>{t("modifiers.edit.heading")}</h1>
        <Flash error={error} />
        <Raw
          html={renderFields(modifierFields, modifierToFieldValues(modifier))}
        />
        <SubmitButton icon="save">{t("common.save_changes")}</SubmitButton>
      </CsrfForm>
      {links && <ScopeLinksForm links={links} modifier={modifier} />}
      <p class="actions">
        <a class="danger" href={`/admin/modifiers/${modifier.id}/delete`}>
          {t("modifiers.delete.submit")}
        </a>
      </p>
    </Layout>,
  );

/** Admin modifier delete confirmation page */
export const adminModifierDeletePage = (
  modifier: Modifier,
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
