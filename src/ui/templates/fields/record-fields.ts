/** The form box of every declared field, built per request so each label
 *  follows the active language. */

import { t } from "#i18n";
import { defineFieldsForm } from "#shared/forms/definition.ts";
import type { ChoiceField, InputField } from "#shared/forms/field.ts";
import type { FormField, FormFieldKind } from "#shared/rest/field-specs.ts";
import { validateDate } from "#templates/fields/validators.ts";

/** The text kinds and the box type each one shows. */
type TextKind = Exclude<FormFieldKind, "switch">;

const BOX_TYPES = {
  date: "date",
  name: "text",
  sealedText: "text",
  text: "text",
} as const satisfies Record<TextKind, InputField["type"]>;

/** The rule each text kind checks before the record reads the value. */
const BOX_RULES: Record<TextKind, Pick<InputField, "validate">> = {
  date: { validate: validateDate },
  name: {},
  sealedText: {},
  text: {},
};

/** One box: a text input, or a one-option checkbox group worth "1". */
type FieldBox<Key extends string> =
  | TextBox<Key>
  | ChoiceField<"checkbox-group", "1", Key>;

/** The translated hint, after its literal prefix, or nothing when the field
 *  declares neither. */
const boxHint = (field: FormField): Pick<InputField, "hint"> => {
  const text = `${field.hintPrefix ?? ""}${
    field.hint === undefined ? "" : t(field.hint)
  }`;
  return text === "" ? {} : { hint: text };
};

/** The either/or pair, with its translated explanation, or nothing. */
const boxExclusive = (field: FormField): Pick<InputField, "exclusive"> =>
  field.exclusive === undefined
    ? {}
    : {
        exclusive: {
          other: field.exclusive.other,
          why: t(field.exclusive.why),
        },
      };

/** A switch box: the one-option checkbox group the status page uses. Its
 *  label travels on the option, so the group needs no separate legend. */
const switchBox = (field: FormField): ChoiceField<"checkbox-group", "1"> => ({
  ...boxExclusive(field),
  label: "",
  name: field.key,
  options: [{ label: t(field.label), value: "1" }],
  type: "checkbox-group",
});

/** One text box: with the required fact and type its field kind shows. */
type TextBox<Key extends string> = InputField<Key> & {
  readonly type: (typeof BOX_TYPES)[TextKind];
};

/** A text box, required unless its field declares a default, with the texts
 *  and rule its field declares. */
const textBox = (field: FormField & { kind: TextKind }): TextBox<string> => ({
  ...boxHint(field),
  ...(field.default === undefined
    ? {}
    : { defaultValue: String(field.default) }),
  label: t(field.label),
  name: field.key,
  ...(field.placeholder === undefined
    ? {}
    : { placeholder: t(field.placeholder) }),
  required: field.default === undefined,
  ...(field.requiredMessageKey === undefined
    ? {}
    : { requiredMessage: t(field.requiredMessageKey) }),
  type: BOX_TYPES[field.kind],
  ...BOX_RULES[field.kind],
});

/** The box of one field. */
const fieldBox = (field: FormField): FieldBox<string> => {
  if (field.kind === "switch") return switchBox(field);
  return textBox(field as FormField & { kind: TextKind });
};

/** The boxes of every field, in declaration order. */
const fieldBoxes = <const Fields extends readonly FormField[]>(
  fields: Fields,
): readonly FieldBox<Fields[number]["key"]>[] =>
  fields.map((field) => fieldBox(field) as FieldBox<Fields[number]["key"]>);

/** The per-request form of one field declaration. */
export const fieldsForm = <const Fields extends readonly FormField[]>(
  fields: Fields,
) => defineFieldsForm(() => fieldBoxes(fields));
