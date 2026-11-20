/**
 * The image upload fields, and the image picker template that renders them.
 * The images area renders the same fields. The admin shell renders the picker
 * once on each admin page as an inert `<template>`. The markdown editor and
 * the new-listing Images field clone it and show it in the shared admin modal.
 * The modal supplies the title bar and the close control. The title is the
 * words that bar shows. The notes after the picker are the copy that its grid
 * shows in place of thumbnails.
 */

import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import type { Field } from "#shared/forms/field.ts";
import { renderField } from "#shared/forms/rendering.tsx";
import { IMAGE_UPLOAD_ACCEPT } from "#shared/images/formats.ts";
import {
  IMAGE_PICKER_ID,
  PICKER_NOTES,
  PICKER_TITLE_COPY,
  type PickerNote,
} from "#shared/images/picker.ts";

/** The name and alt text that every image form edits. */
const imageFieldsFor = (altTextType: "text" | "textarea"): Field[] => [
  {
    label: t("images.field.name"),
    name: "name",
    required: true,
    type: "text",
  },
  {
    label: t("images.field.alt_text"),
    name: "altText",
    type: altTextType,
  },
];

export const imageFields = (): Field[] => imageFieldsFor("text");

/** The picker's alt text box is a textarea, because it can run past one line. */
const pickerFields = (): Field[] => imageFieldsFor("textarea");

// No `required`: file inputs never render the attribute (renderFieldInput
// omits it) and the upload POST checks the file's presence itself.
const imageUploadField = (): Field => ({
  accept: IMAGE_UPLOAD_ACCEPT,
  label: t("images.field.file"),
  name: "image",
  type: "file",
});

/** The fields that an image upload carries. */
export const imageUploadFields = (): Field[] => [
  ...imageFields(),
  imageUploadField(),
];

/** The fields the picker's upload form carries. */
const pickerUploadFields = (): Field[] => [
  ...pickerFields(),
  imageUploadField(),
];

/** One note for each grid state. A missing state fails to compile. */
const PickerNotes = (copy: Record<PickerNote, string>): JSX.Element => (
  <>
    {PICKER_NOTES.map((note) => (
      <p class="md-image-note" data-note={note}>
        {copy[note]}
      </p>
    ))}
  </>
);

/** The upload fields, always empty. The page around the picker can carry a
 * failed form's saved values, and `renderFields` fills fields from them. */
const EmptyUploadFields = (): JSX.Element => (
  <>
    {pickerUploadFields().map((field) => (
      <Raw html={renderField(field)} />
    ))}
  </>
);

export const ImagePickerTemplate = (): JSX.Element => (
  <template id={IMAGE_PICKER_ID}>
    <span data-copy={PICKER_TITLE_COPY}>{t("images.picker.heading")}</span>
    <div class="md-image-picker">
      <div class="md-image-columns">
        <CsrfForm
          action="/admin/images"
          class="md-image-upload"
          enctype="multipart/form-data"
        >
          <h3>{t("images.item.upload_new")}</h3>
          <EmptyUploadFields />
          <button type="submit">{t("images.item.upload_submit")}</button>
        </CsrfForm>
        <div class="md-image-selection">
          <div class="md-image-grid"></div>
          <button class="md-image-confirm" hidden type="button">
            {t("images.picker.add")}
          </button>
        </div>
      </div>
    </div>
    <PickerNotes
      empty={t("images.empty")}
      loadFailed={t("images.picker.load_failed")}
      loading={t("images.picker.loading")}
      uploadFailed={t("images.picker.upload_failed")}
    />
  </template>
);
