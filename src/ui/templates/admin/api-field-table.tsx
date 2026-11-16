/**
 * The table of fields one documented request body takes.
 */

import { t } from "#i18n";
import type {
  FieldDocRow,
  ValueForm,
} from "#shared/admin-api-example/field-docs.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { LabelledBlock } from "#templates/components/labelled-block.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";

/** The words for one value form. A form that holds another form names it in
 *  its own words. */
const valueText = (value: ValueForm): string =>
  t(`api_keys.fields.value.${value.form}`, {
    ...("min" in value ? { min: value.min } : {}),
    ...("max" in value ? { max: value.max } : {}),
    ...("of" in value ? { of: valueText(value.of) } : {}),
    ...("names" in value ? { names: value.names.join(", ") } : {}),
  });

const fieldTable = defineTable<FieldDocRow>([
  translatedTableColumn("field", "api_keys.fields.col.field", (row) => (
    <code>{row.key}</code>
  )),
  translatedTableColumn("value", "api_keys.fields.col.value", (row) =>
    valueText(row.value),
  ),
  translatedTableColumn("required", "api_keys.fields.col.required", (row) =>
    t(row.required ? "common.yes" : "common.no"),
  ),
  translatedTableColumn(
    "default",
    "api_keys.fields.col.default",
    (row) => row.defaultJson !== null && <code>{row.defaultJson}</code>,
  ),
]);

/** The labelled table of the fields one request body takes. */
export const FieldTable = ({
  rows,
}: {
  rows: readonly FieldDocRow[];
}): JSX.Element => (
  <LabelledBlock label={t("api_keys.fields.label")}>
    {renderTable(fieldTable, rows)}
  </LabelledBlock>
);
