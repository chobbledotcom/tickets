/**
 * Group form field definitions — create (no slug, auto-generated) and edit
 * (slug appended between name and description).
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { defineFieldsForm, type FormValues } from "#shared/forms/definition.ts";
import type { ChoiceField, Field, InputField } from "#shared/forms/field.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { formattingHint } from "#templates/components/formatting-hint.ts";
import {
  buildDescriptionField,
  buildHiddenField,
  getSlugField,
} from "#templates/fields/validators.ts";

/* jscpd:ignore-end */

/** Max attendees field for group forms */
const getGroupMaxAttendeesField = () =>
  ({
    hint: t("fields.group.max_attendees_hint"),
    label: t("fields.group.max_attendees"),
    name: "max_attendees",
    type: "number",
  }) satisfies InputField<"max_attendees">;

/** Group description field */
const getGroupDescriptionField = () =>
  buildDescriptionField(t("fields.group.description_hint"), formattingHint());

/** A single "is" checkbox for a group form field. The label, hint, and option
 * copy all live under `fields.group.<name>` in the message catalog. Toggling
 * the box reveals companion UI on the edit page via the CSS sibling trick. */
const getGroupCheckboxField =
  <Name extends GroupToggleName>(name: Name) =>
  (): ChoiceField<"checkbox-group", "1", Name> => ({
    hint: t(`fields.group.${name}_hint`),
    label: t(`fields.group.${name}`),
    name,
    options: [{ label: t(`fields.group.${name}_label`), value: "1" }],
    type: "checkbox-group",
  });

/** The toggles a group form offers, in display order. "Is a package"
 * Toggling it reveals the per-listing price override table on the edit page.
 * "Hide listings within package" and "Show hidden listings" each apply to one
 * group kind, so the edit page reveals/hides them via the same CSS trick;
 * see the form-visibility section of the stylesheet. */
const groupToggleNames = [
  "is_package",
  "hide_package_listings",
  "show_hidden_listings",
] as const;
type GroupToggleName = (typeof groupToggleNames)[number];

/** Group form fields for creation (no slug - auto-generated) */
const groupCreateFields = () => {
  const groupHiddenField = buildHiddenField("Group");
  return [
    {
      label: t("fields.group.name"),
      name: "name",
      placeholder: t("fields.group.name_placeholder"),
      required: true,
      type: "text",
    },
    getGroupDescriptionField(),
    getGroupMaxAttendeesField(),
    {
      hint: t("fields.group.terms_hint"),
      hintHtml: formattingHint(),
      label: t("fields.group.terms"),
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      name: "terms_and_conditions",
      type: "textarea",
      validate: (value: string) =>
        value.length > MAX_TEXTAREA_LENGTH
          ? t("fields.validation.terms_max", { max: MAX_TEXTAREA_LENGTH })
          : null,
    },
    groupHiddenField,
    ...groupToggleNames.map((name) => getGroupCheckboxField(name)()),
  ] as const satisfies readonly Field[];
};

export const getGroupCreateForm = defineFieldsForm(groupCreateFields);

/** Group form field definitions (edit - includes slug) */
const groupEditFields = () => {
  const [name, ...remainingFields] = groupCreateFields();
  return [name, getSlugField(), ...remainingFields] as const;
};

export const getGroupForm = defineFieldsForm(groupEditFields);

export type GroupCreateFormValues = FormValues<
  ReturnType<typeof getGroupCreateForm>
>;
export type GroupFormValues = FormValues<ReturnType<typeof getGroupForm>>;
