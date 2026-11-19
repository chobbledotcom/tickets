/**
 * The image upload fields, and the markdown editor's image picker that
 * renders them. The images area renders the same fields. The admin shell
 * renders the picker once on each admin page as an inert `<template>`. The
 * editor clones it for each rich editor and adds the behaviour. The notes
 * after the dialog are the copy that the picker's grid shows in place of
 * thumbnails.
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
  type PickerNote,
} from "#shared/images/picker.ts";
import { Icon } from "#templates/components/actions.tsx";

/** The name and alt text that every image form edits. */
export const imageFields = (): Field[] => [
  {
    label: t("images.field.name"),
    name: "name",
    required: true,
    type: "text",
  },
  {
    label: t("images.field.alt_text"),
    name: "altText",
    type: "text",
  },
];

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
    {imageUploadFields().map((field) => (
      <Raw html={renderField(field)} />
    ))}
  </>
);

export const ImagePickerTemplate = (): JSX.Element => (
  <template id={IMAGE_PICKER_ID}>
    <dialog class="md-image-dialog">
      <button
        aria-label={t("images.picker.close")}
        class="md-preview-close"
        type="button"
      >
        <Icon name="x" />
      </button>
      <h2>{t("images.picker.heading")}</h2>
      <div class="md-image-grid"></div>
      <CsrfForm
        action="/admin/images"
        class="md-image-upload"
        enctype="multipart/form-data"
      >
        <h3>{t("images.item.upload_new")}</h3>
        <EmptyUploadFields />
        <button type="submit">{t("images.item.upload_submit")}</button>
      </CsrfForm>
    </dialog>
    <PickerNotes
      empty={t("images.empty")}
      loading={t("images.picker.loading")}
      uploadFailed={t("images.picker.upload_failed")}
    />
  </template>
);
