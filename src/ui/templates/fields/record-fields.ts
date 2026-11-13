/** The form box of every declared field, built per request so each label
 *  follows the active language. */

import { t } from "#i18n";
import { defineFieldsForm } from "#shared/forms/definition.ts";
import type { InputField } from "#shared/forms/field.ts";
import type { FieldKind, FieldSpecs } from "#shared/rest/field-specs.ts";
import { validateDate } from "#templates/fields/validators.ts";

/** The box type each kind shows. */
const BOX_TYPES = { date: "date", name: "text" } as const satisfies Record<
  FieldKind,
  InputField["type"]
>;

/** The box one field shows. Every declared field is required. */
type FieldBox<Key extends string> = InputField<Key> & {
  readonly required: true;
  readonly type: (typeof BOX_TYPES)[FieldKind];
};

/** The rule each kind checks before the record reads the value. */
const BOX_RULES: Record<FieldKind, Pick<InputField, "validate">> = {
  date: { validate: validateDate },
  name: {},
};

/** One translated box text, or nothing when the field declares none. */
const boxText = (
  property: "hint" | "placeholder",
  key: string | undefined,
): Pick<InputField, "hint" | "placeholder"> =>
  key === undefined ? {} : { [property]: t(key) };

/** The boxes of every field, in declaration order. */
const fieldBoxes = <const Fields extends FieldSpecs>(
  fields: Fields,
): readonly FieldBox<Fields[number]["key"]>[] =>
  fields.map(
    (field: Fields[number]): FieldBox<Fields[number]["key"]> => ({
      ...boxText("hint", field.hint),
      label: t(field.label),
      name: field.key,
      ...boxText("placeholder", field.placeholder),
      required: true,
      type: BOX_TYPES[field.kind],
      ...BOX_RULES[field.kind],
    }),
  );

/** The per-request form of one field declaration. */
export const fieldsForm = <const Fields extends FieldSpecs>(fields: Fields) =>
  defineFieldsForm(() => fieldBoxes(fields));
