/**
 * Group form field definitions — create (no slug, auto-generated) and edit
 * (slug appended between name and description).
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { defineForm, type FormValues } from "#shared/forms/definition.ts";
import type { ChoiceField, Field, InputField } from "#shared/forms.tsx";
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

/** "Is a package" checkbox for group forms. Toggling it reveals the per-listing
 * price override table on the edit page via the CSS sibling trick. */
const getIsPackageField = (): ChoiceField<
  "checkbox-group",
  "1",
  "is_package"
> => ({
  hint: t("fields.group.is_package_hint"),
  label: t("fields.group.is_package"),
  name: "is_package",
  options: [{ label: t("fields.group.is_package_label"), value: "1" }],
  type: "checkbox-group",
});

/** "Hide listings within package" checkbox. Only meaningful for packages, so the
 * edit page reveals it via the same CSS trick as the price table. */
const getHidePackageListingsField = (): ChoiceField<
  "checkbox-group",
  "1",
  "hide_package_listings"
> => ({
  hint: t("fields.group.hide_package_listings_hint"),
  label: t("fields.group.hide_package_listings"),
  name: "hide_package_listings",
  options: [
    { label: t("fields.group.hide_package_listings_label"), value: "1" },
  ],
  type: "checkbox-group",
});

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
    getIsPackageField(),
    getHidePackageListingsField(),
  ] as const satisfies readonly Field[];
};

export const getGroupCreateForm = () =>
  defineForm({ fields: groupCreateFields(), id: "group-create" });

/** Group form field definitions (edit - includes slug) */
export const getGroupForm = () => {
  const [
    name,
    description,
    maxAttendees,
    terms,
    hidden,
    isPackage,
    hideListings,
  ] = groupCreateFields();
  return defineForm({
    fields: [
      name,
      getSlugField(),
      description,
      maxAttendees,
      terms,
      hidden,
      isPackage,
      hideListings,
    ] as const,
    id: "group-edit",
  });
};

export type GroupCreateFormValues = FormValues<
  ReturnType<typeof getGroupCreateForm>
>;
export type GroupFormValues = FormValues<ReturnType<typeof getGroupForm>>;
