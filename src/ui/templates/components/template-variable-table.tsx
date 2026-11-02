/**
 * The reference table under a template settings box: one row per variable an
 * owner can type, with plain words about what it holds.
 *
 * One component serves every editable template's reference, so two surfaces
 * cannot describe the same variables in two shapes.
 */

import { t } from "#i18n";

export const TemplateVariableTable = ({
  variables,
}: {
  /** [what the owner types, the message key describing it], in the order the
   * table lists them. */
  variables: readonly (readonly [code: string, key: string])[];
}): JSX.Element => (
  <div class="table-scroll">
    <table>
      {variables.map(([code, key]) => (
        <tr>
          <td>
            <code>{code}</code>
          </td>
          <td>{t(key)}</td>
        </tr>
      ))}
    </table>
  </div>
);
