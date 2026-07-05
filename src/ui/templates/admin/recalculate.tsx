/* jscpd:ignore-start */
import { RECALCULATE_FIELD_NAME } from "#shared/recalculate-fields.ts";
import type { AdminSession } from "#shared/types.ts";
import { adminFormPage } from "#templates/admin/admin-page.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { DataTable } from "#templates/components/data-table.tsx";
/* jscpd:ignore-end */

export type RecalculateRow = {
  current: string;
  label: string;
  name: string;
  recalculated: string;
};

export const adminRecalculatePage = ({
  action,
  active,
  currentLabel,
  description,
  error,
  recalculatedLabel,
  rows,
  session,
  success,
  submitLabel,
  title,
}: {
  action: string;
  active: string;
  currentLabel: string;
  description: string;
  error?: string | undefined;
  recalculatedLabel: string;
  rows: RecalculateRow[];
  session: AdminSession;
  success?: string | undefined;
  submitLabel: string;
  title: string;
}): string =>
  adminFormPage({
    action,
    active,
    children: (
      <>
        <div class="prose">
          <p>{description}</p>
        </div>
        <DataTable
          columns={[
            { header: "" },
            { header: currentLabel },
            { header: recalculatedLabel },
          ]}
          rows={rows.map((row) => (
            <tr>
              <th>
                <label>
                  <input
                    name={RECALCULATE_FIELD_NAME}
                    type="checkbox"
                    value={row.name}
                  />{" "}
                  {row.label}
                </label>
              </th>
              <td>{row.current}</td>
              <td>{row.recalculated}</td>
            </tr>
          ))}
        />
        <SubmitButton icon="save">{submitLabel}</SubmitButton>
      </>
    ),
    error,
    session,
    success,
    title,
  });
