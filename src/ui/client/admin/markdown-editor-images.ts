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
import {
  IMAGE_PICKER_ID,
  type ImageOption,
  LAZY_THUMBNAIL_FROM,
  type PickerNote,
} from "#shared/images/picker.ts";
import { shortFormImageAddress } from "#shared/images/short-form.ts";
import {
  createImageLibrary,
  type ImageLibrary,
  imageNodeView,
} from "#src/ui/client/admin/markdown-editor-image-view.ts";
import { createToolbarButton } from "#src/ui/client/admin/markdown-editor-toolbar.ts";
import { createButton, requiredChild } from "#src/ui/client/dom.ts";

/** The facts an inserted reference needs: the id it names and its alt text. */
type ImageChoice = Pick<ImageOption, "id" | "name">;

/** The grid's states, as `data-state` names them. */
type GridState = "error" | "loading" | "ready";

/** One editor's picker: the cloned dialog's parts, the template its notes
 * come from, and the library its grid shows. */
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

/** The page's picker template. Null on a page without image storage. */
const pickerTemplateOrNull = (): HTMLTemplateElement | null =>
  document.querySelector<HTMLTemplateElement>(`template#${IMAGE_PICKER_ID}`);

/** A fresh copy of one of the template's notes. */
const noteFrom = (picker: Picker, note: PickerNote): Node =>
  document.importNode(
    requiredChild(picker.template.content, `[data-note="${note}"]`),
    true,
  );

/** Puts the grid in a state and shows that state's content. */
const fillGrid = (picker: Picker, state: GridState, content: Node[]): void => {
  picker.grid.dataset.state = state;
  picker.grid.replaceChildren(...content);
};

/** The library's answer fills the grid only while the dialog is open. A
 * dialog closed before the answer stays as it is. */
const settleGrid = (
  picker: Picker,
  state: GridState,
  content: Node[],
): void => {
  if (picker.dialog.open) fillGrid(picker, state, content);
};

/** The dialog's close gives the caret back to the editor. */
const chooseImage = (picker: Picker, choice: ImageChoice): void => {
  insertImageRef(picker.editor(), choice);
  picker.dialog.close();
};

/** One thumbnail button. The thumbnail is decorative: the button's text
 * carries the name. */
const optionButton = (
  picker: Picker,
  option: ImageOption,
  index: number,
): HTMLButtonElement => {
  const item = createButton("md-image-option");
  item.title = option.name;
  const image = document.createElement("img");
  image.alt = "";
  image.loading = index >= LAZY_THUMBNAIL_FROM ? "lazy" : "eager";
  image.src = option.thumb;
  item.append(image, option.name);
  item.addEventListener("click", () => chooseImage(picker, option));
  return item;
};

/** The thumbnails, or the empty note for a library without images. */
const optionNodes = (picker: Picker, options: ImageOption[]): Node[] => {
  if (options.length === 0) return [noteFrom(picker, "empty")];
  return options.map((option, index) => optionButton(picker, option, index));
};

/** A failed load is never cached, so the next open retries. */
const showUnavailable = (picker: Picker): void => {
  picker.library.forget();
  settleGrid(picker, "error", [noteFrom(picker, "unavailable")]);
};

const openPicker = (picker: Picker): void => {
  // A destroyed editor's view cannot dispatch, and the teardown leaves the
  // button mounted: the control stays inert.
  if (picker.editor().isDestroyed) return;
  fillGrid(picker, "loading", [noteFrom(picker, "loading")]);
  picker.dialog.showModal();
  void picker.library.load().then(
    (options) => settleGrid(picker, "ready", optionNodes(picker, options)),
    () => showUnavailable(picker),
  );
};

/** The upload answers with a redirect to the new image's edit page. The
 * image id is the path segment that route carries. */
const uploadedId = (url: string): number => {
  const match = /\/admin\/images\/(\d+)\/edit/.exec(new URL(url).pathname);
  if (match === null) {
    throw new Error("image upload responded without an image id");
  }
  return Number(match[1]);
};

/** Adds one form field to the multipart body. A chosen file travels as a
 * native Blob, so the server sees the upload unchanged. */
const appendField = async (
  body: FormData,
  input: HTMLInputElement,
): Promise<void> => {
  if (input.type !== "file") {
    body.append(input.name, input.value);
    return;
  }
  const file = input.files?.[0];
  if (file === undefined) return;
  body.append(
    input.name,
    new Blob([await file.arrayBuffer()], { type: file.type }),
    file.name,
  );
};

/** Posts the upload form's fields to its action and answers the new
 * image's id. Only the redirect to the new image's edit page proves the
 * upload. That page can still fail to load, and the image then exists. */
const uploadImage = async (form: HTMLFormElement): Promise<number> => {
  const body = new FormData();
  for (const input of form.querySelectorAll("input")) {
    await appendField(body, input);
  }
  const response = await fetch(form.action, { body, method: "POST" });
  return uploadedId(response.url);
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
 * page. A native POST navigates away and loses them. */
const submitUpload = (picker: Picker, event: Event): void => {
  // The dialog nests inside the page's own form: without this stop the
  // submit bubbles up and submits the page too.
  event.stopPropagation();
  event.preventDefault();
  if (picker.submit.disabled) return;
  picker.submit.disabled = true;
  const name = picker.name.value;
  void uploadImage(picker.form)
    .then(
      (id) => finishUpload(picker, { id, name }),
      () => picker.grid.replaceChildren(noteFrom(picker, "uploadFailed")),
    )
    .finally(() => {
      picker.submit.disabled = false;
    });
};

/** Clones the template's dialog and names the parts the picker drives. */
const clonePicker = (
  template: HTMLTemplateElement,
  library: ImageLibrary,
  editor: () => EditorView,
): Picker => {
  const dialog = document.importNode(
    requiredChild<HTMLDialogElement>(template.content, "dialog"),
    true,
  );
  const form = requiredChild<HTMLFormElement>(dialog, "form");
  return {
    dialog,
    editor,
    form,
    grid: requiredChild<HTMLElement>(dialog, ".md-image-grid"),
    library,
    name: requiredChild<HTMLInputElement>(form, 'input[name="name"]'),
    submit: requiredChild<HTMLButtonElement>(form, 'button[type="submit"]'),
    template,
  };
};

const wirePicker = (picker: Picker, button: HTMLButtonElement): void => {
  const { dialog } = picker;
  requiredChild(dialog, ".md-preview-close").addEventListener("click", () =>
    dialog.close(),
  );
  // Clicking the backdrop (the dialog element itself) closes, as the preview
  // dialog does. Escape closes through the native cancel path. Every close
  // gives the caret back to the editor, so the operator can keep writing.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => picker.editor().focus());
  picker.form.addEventListener("submit", (event) =>
    submitUpload(picker, event),
  );
  // While the modal dialog is open its backdrop swallows clicks, so the
  // button only ever opens.
  button.addEventListener("click", () => openPicker(picker));
};

/** The image control: the element for the toolbar row and the plugin that
 * binds the editor view and renders the image nodes. */
export interface ImageToolbarItem {
  element: HTMLElement;
  plugin: Plugin;
}

/** Build the toolbar's image control: the button and its modal dialog. The
 * dialog lives inside the editor's mount, so it dies with the editor and
 * survives the plugin-view recreations the rich/raw toggle's state rebuild
 * causes. */
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
    const picker = clonePicker(template, library, () => view);
    mount.append(picker.dialog);
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
