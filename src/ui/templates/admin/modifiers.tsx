/**
 * Admin price-modifier management page templates
 */

import { isReadOnly } from "#shared/env.ts";
import {
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

/** Human-readable summary of a modifier's rule, e.g. "Charge · 10%". */
const ruleSummary = (m: Modifier): string => {
  const action = m.direction === "discount" ? "Discount" : "Charge";
  if (m.calc_kind === "percent") return `${action} · ${m.calc_value}%`;
  if (m.calc_kind === "multiply") return `Multiply · ×${m.calc_value}`;
  return `${action} · ${m.calc_value}`;
};

/** Pre-fill form values from a modifier (or blanks for the create form). */
export const modifierToFieldValues = (
  modifier?: Modifier,
): Record<string, string | number | null> =>
  entityToFieldValues(modifier, modifierFields, {});

/** Admin modifiers list page */
export const adminModifiersPage = (
  modifiers: Modifier[],
  session: AdminSession,
  successMessage?: string,
): string =>
  String(
    <Layout title="Modifiers">
      <AdminNav active="/admin/modifiers" session={session} />
      <Flash success={successMessage} />
      {!isReadOnly() && (
        <p class="actions">
          <ActionButton href="/admin/modifiers/new" icon="plus">
            Add Modifier
          </ActionButton>
        </p>
      )}
      {modifiers.length === 0 ? (
        <p>No modifiers configured.</p>
      ) : (
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Rule</th>
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
    <Layout title="Add Modifier">
      <AdminNav active="/admin/modifiers" session={session} />
      <CsrfForm action="/admin/modifiers">
        <h1>Add Modifier</h1>
        <Flash error={error} />
        <Raw html={renderFields(modifierFields, modifierToFieldValues())} />
        <SubmitButton icon="plus">Create Modifier</SubmitButton>
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
    <Layout title="Edit Modifier">
      <AdminNav active="/admin/modifiers" session={session} />
      <CsrfForm action={`/admin/modifiers/${modifier.id}/edit`}>
        <h1>Edit Modifier</h1>
        <Flash error={error} />
        <Raw
          html={renderFields(modifierFields, modifierToFieldValues(modifier))}
        />
        <SubmitButton icon="save">Save Changes</SubmitButton>
      </CsrfForm>
      <p class="actions">
        <a class="danger" href={`/admin/modifiers/${modifier.id}/delete`}>
          Delete Modifier
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
    <Layout title="Delete Modifier">
      <AdminNav active="/admin/modifiers" session={session} />
      <ConfirmForm
        action={`/admin/modifiers/${modifier.id}/delete`}
        buttonText="Delete Modifier"
        danger={false}
        label="Modifier name"
        name={modifier.name}
      >
        <h1>Delete Modifier</h1>
        <Flash error={error} />
        <p>
          Are you sure you want to delete the modifier{" "}
          <strong>{modifier.name}</strong>?
        </p>
        <p>Type the modifier name "{modifier.name}" to confirm:</p>
      </ConfirmForm>
    </Layout>,
  );
