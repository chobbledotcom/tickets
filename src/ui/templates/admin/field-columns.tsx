/** The list column of every declared field, in declaration order. A name
 *  links to its record. Any other field shows its stored text. */

import type {
  FieldsStored,
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

/** The link to the page of one record. */
type EditHref = (row: { id: number }) => string;

/** The arguments that link a list to its records. A list with a name column
 *  needs the link. A list with none takes no link. */
type EditLink<Fields extends readonly ShownField[]> =
  Extract<Fields[number], { kind: "name" }> extends never
    ? []
    : [editHref: EditHref];

/** The column that shows the stored text of a field. */
const textColumn = (field: ShownField, text: RowText) => ({
  cell: text,
  header: translatedTableHeader(field.header),
  key: field.key,
});

const KIND_COLUMNS: Record<
  ShownKind,
  (
    field: ShownField,
    text: RowText,
    editHref: EditHref,
  ) => TableColumn<StoredRow>
> = {
  date: textColumn,
  name: (field, text, editHref) => ({
    ...writableNameColumn(editHref, text),
    header: translatedTableHeader(field.header),
  }),
  sealedText: textColumn,
};

/** The columns of every field, for a table of the rows they declare. */
export const fieldTableColumns = <const Fields extends readonly ShownField[]>(
  fields: Fields,
  ...link: EditLink<Fields>
): TableColumn<FieldsStored<Fields>>[] =>
  // Every declared row is a stored row, so each column reads it. Only a name
  // column reads the link, and the type gives a list with a name its link.
  fields.map((field) =>
    KIND_COLUMNS[field.kind](
      field,
      (row) => String(row[field.key]),
      (link as readonly [EditHref])[0],
    ),
  ) as TableColumn<FieldsStored<Fields>>[];
