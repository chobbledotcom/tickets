/** The list column of every declared field, in declaration order. A name
 *  links to its record. Any other field shows its stored text. */

import type {
  FieldsRow,
  ShownField,
  ShownKind,
} from "#shared/rest/field-specs.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { writableNameColumn } from "#templates/admin/resource-pages.tsx";
import { translatedTableHeader } from "#templates/components/translated-table-column.ts";

/** One stored row, as the column builders read it. */
type StoredRow = Readonly<Record<string, string | number>> & { id: number };

/** The stored text of one row's field. */
type RowText = (row: StoredRow) => string;

const KIND_COLUMNS: Record<
  ShownKind,
  (
    field: ShownField,
    text: RowText,
    editHref: (row: { id: number }) => string,
  ) => TableColumn<StoredRow>
> = {
  date: (field, text) => ({
    cell: text,
    header: translatedTableHeader(field.header),
    key: field.key,
  }),
  name: (field, text, editHref) => ({
    ...writableNameColumn(editHref, text),
    header: translatedTableHeader(field.header),
  }),
};

/** The columns of every field, for a table of the rows they declare. */
export const fieldTableColumns = <const Fields extends readonly ShownField[]>(
  fields: Fields,
  editHref: (row: { id: number }) => string,
): TableColumn<FieldsRow<Fields>>[] =>
  // Every declared row is a stored row, so each column reads it.
  fields.map((field) =>
    KIND_COLUMNS[field.kind](field, (row) => String(row[field.key]), editHref),
  ) as TableColumn<FieldsRow<Fields>>[];
