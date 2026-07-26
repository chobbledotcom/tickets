/* jscpd:ignore-start */
import { RECALCULATE_FIELD_NAME } from "#shared/recalculate-fields.ts";
import { defineTable } from "#shared/tables/definition.ts";
import type { AdminSession } from "#shared/types.ts";
import { adminFormPage } from "#templates/admin/admin-page.tsx";
import type { NavActive } from "#templates/admin/nav.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { renderTable } from "#templates/components/table.tsx";
/* jscpd:ignore-end */

export type RecalculateRow = {
  current: string;
  label: string;
  name: string;
  recalculated: string;
};

const recalculateTable = (currentLabel: string, recalculatedLabel: string) =>
  defineTable<RecalculateRow>([
    {
      cell: (row) => (
        <label>
          <input
            name={RECALCULATE_FIELD_NAME}
            type="checkbox"
            value={row.name}
          />{" "}
          {row.label}
        </label>
      ),
      header: "",
      key: "field",
      rowHeader: true,
    },
    {
      cell: (row) => row.current,
      header: currentLabel,
      key: "current",
    },
    {
      cell: (row) => row.recalculated,
      header: recalculatedLabel,
      key: "recalculated",
    },
  ]);

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
  active: NavActive;
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
        {renderTable(recalculateTable(currentLabel, recalculatedLabel), rows)}
        <SubmitButton icon="save">{submitLabel}</SubmitButton>
      </>
    ),
    error,
    session,
    success,
    title,
  });
