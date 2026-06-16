/**
 * Admin price-modifier management page templates
 */

import { t } from "#i18n";
import { toMajorUnits } from "#shared/currency.ts";
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
              </tr>
            </thead>
            <tbody>
              {modifiers.map((m) => (
                <tr>
                  <td>
                    <a href={`/admin/modifiers/${m.id}/edit`}>{m.name}</a>
                  </td>
                  <td>{ruleSummary(m)}</td>
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

/** Admin modifier edit page */
export const adminModifierEditPage = (
  modifier: Modifier,
  session: AdminSession,
  error?: string,
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
