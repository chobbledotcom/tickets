/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The image picker for the markdown editor toolbar. The server renders the
 * picker's markup on each admin page with image storage, as a `<template>`.
 * Each editor clones it, fills the grid from the image library, uploads new
 * images, and inserts the short-form reference (`![Alt](img#id)`) at the
 * caret. The server translates img#id to the real image URL at render time,
 * so the editor stores the stable short form.
 */

import { schema } from "prosemirror-markdown";
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { ImageOption } from "#shared/images/picker.ts";
import { shortFormImageAddress } from "#shared/images/short-form.ts";
import {
  createImageLibrary,
  type ImageLibrary,
  imageNodeView,
} from "#src/ui/client/admin/markdown-editor-image-view.ts";
import { createToolbarButton } from "#src/ui/client/admin/markdown-editor-toolbar.ts";
import { requiredChild } from "#src/ui/client/dom.ts";
import {
  clonePickerDialog,
  fillGrid,
  noteFrom,
  optionButton,
  pickerTemplateOrNull,
  uploadedIdOrNull,
  wireDialogClose,
} from "./image-picker-template.ts";

/** The facts an inserted reference needs: the id it names and its alt text. */
type ImageChoice = Pick<ImageOption, "id" | "name">;

/** One editor's picker: the cloned dialog's parts, the template its notes
 *  come from, and the library its grid shows. */
interface Picker {
  dialog: HTMLDialogElement;
  editor: () => EditorView;
  form: HTMLFormElement;
  grid: HTMLElement;
  library: ImageLibrary;
  name: HTMLInputElement;
  submit: HTMLButtonElement;
  template: HTMLTemplateElement;
}

/** Inserts the short-form image reference at the caret. */
const insertImageRef = (view: EditorView, choice: ImageChoice): void => {
  view.dispatch(
    view.state.tr
      .replaceSelectionWith(
        schema.nodes.image.create({
          alt: choice.name,
          src: shortFormImageAddress(choice.id),
        }),
      )
      .scrollIntoView(),
  );
};

/** The dialog's close gives the caret back to the editor. */
const chooseImage = (picker: Picker, choice: ImageChoice): void => {
  insertImageRef(picker.editor(), choice);
  picker.dialog.close();
};

/** The thumbnails, or the empty note for a library without images. */
const optionNodes = (picker: Picker, options: ImageOption[]): Node[] => {
  if (options.length === 0) return [noteFrom(picker.template, "empty")];
  return options.map((option, index) =>
    optionButton(option, index, () => chooseImage(picker, option)),
  );
};

/** The page renders the picker only with image storage, so a library that
 *  cannot load means the server is down. The failure is not caught. */
const openPicker = async (picker: Picker): Promise<void> => {
  // A destroyed editor's view cannot dispatch, and the teardown leaves the
  // button mounted: the control stays inert.
  if (picker.editor().isDestroyed) return;
  fillGrid(picker.grid, "loading", [noteFrom(picker.template, "loading")]);
  picker.dialog.showModal();
  const options = await picker.library.load();
  // A dialog closed before the answer stays as it is.
  if (picker.dialog.open) {
    fillGrid(picker.grid, "ready", optionNodes(picker, options));
  }
};

const finishUpload = (picker: Picker, choice: ImageChoice): void => {
  // The library changed under the cached list. The next open refetches, and
  // the inserted picture's own lookup finds the new image's URL.
  picker.library.forget();
  // The next open offers a clean form, ready for another upload.
  picker.form.reset();
  chooseImage(picker, choice);
};

/** The submit is intercepted, so the unsaved description edits stay on the
 *  page. A native POST navigates away and loses them. */
const submitUpload = async (picker: Picker, event: Event): Promise<void> => {
  // The dialog nests inside the page's own form: without this stop the
  // submit bubbles up and submits the page too.
  event.stopPropagation();
  event.preventDefault();
  if (picker.submit.disabled) return;
  picker.submit.disabled = true;
  const name = picker.name.value;
  const id = await uploadedIdOrNull(picker.form);
  picker.submit.disabled = false;
  if (id === null) {
    picker.grid.replaceChildren(noteFrom(picker.template, "uploadFailed"));
    return;
  }
  finishUpload(picker, { id, name });
};

/** Clones the template's dialog and names the parts the picker drives. */
const clonePicker = (
  template: HTMLTemplateElement,
  mount: HTMLElement,
  library: ImageLibrary,
  editor: () => EditorView,
): Picker => {
  const parts = clonePickerDialog(template, mount);
  return {
    ...parts,
    editor,
    library,
    name: requiredChild<HTMLInputElement>(parts.form, 'input[name="name"]'),
    submit: requiredChild<HTMLButtonElement>(
      parts.form,
      'button[type="submit"]',
    ),
    template,
  };
};

const wirePicker = (picker: Picker, button: HTMLButtonElement): void => {
  const { dialog } = picker;
  wireDialogClose(dialog, () => picker.editor().focus());
  picker.form.addEventListener(
    "submit",
    (event) => void submitUpload(picker, event),
  );
  // While the modal dialog is open its backdrop swallows clicks, so the
  // button only ever opens.
  button.addEventListener("click", () => void openPicker(picker));
};

/** The image control: the element for the toolbar row and the plugin that
 *  binds the editor view and renders the image nodes. */
export interface ImageToolbarItem {
  element: HTMLElement;
  plugin: Plugin;
}

/** Build the toolbar's image control: the button and its modal dialog. The
 *  dialog lives inside the editor's mount, so it dies with the editor and
 *  survives the plugin-view recreations the rich/raw toggle's state rebuild
 *  causes. */
export const createImageToolbarItem = (
  mount: HTMLElement,
): ImageToolbarItem => {
  const button = createToolbarButton(
    "md-toolbar-button md-toolbar-image",
    "Image",
    "Insert image",
  );
  button.setAttribute("aria-haspopup", "dialog");
  const library = createImageLibrary();
  // The plugin's view callback sets this during the EditorView constructor,
  // before any click can reach the control.
  let view: EditorView;
  const template = pickerTemplateOrNull();
  // Without image storage the control hides, rather than offer a picker that
  // cannot store anything.
  button.hidden = template === null;
  if (template !== null) {
    const picker = clonePicker(template, mount, library, () => view);
    wirePicker(picker, button);
  }

  // ProseMirror stores whatever the view callback returns and probes it for
  // update/destroy, so that value must be an object. The image node view
  // resolves through the same library cache the picker uses.
  const plugin = new Plugin({
    props: { nodeViews: { image: imageNodeView(library) } },
    view: (editorView) => {
      view = editorView;
      return {};
    },
  });

  return { element: button, plugin };
};
