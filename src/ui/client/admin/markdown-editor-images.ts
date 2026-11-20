/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The image picker for the markdown editor toolbar. The server renders the
 * picker's markup on each admin page with image storage, as a `<template>`.
 * Each editor clones it and shows it in the shared admin modal, fills the grid
 * from the image library, uploads new images, and inserts the short-form
 * reference (`![Alt](img#id)`) at the caret. The server translates img#id to
 * the real image URL at render time, so the editor stores the stable short
 * form.
 */

import { schema } from "prosemirror-markdown";
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { ImageChoice } from "#shared/images/picker.ts";
import { shortFormImageAddress } from "#shared/images/short-form.ts";
import {
  createImageLibrary,
  type ImageLibrary,
  imageNodeView,
} from "#src/ui/client/admin/markdown-editor-image-view.ts";
import { createToolbarButton } from "#src/ui/client/admin/markdown-editor-toolbar.ts";
import {
  closeAdminModal,
  isAdminModalOpen,
} from "#src/ui/client/admin/modal.ts";
import {
  clonePicker,
  fillGrid,
  imageOptionNodes,
  noteFrom,
  optionButton,
  type PickerParts,
  pickerTemplateOrNull,
  showPicker,
  wireUploadForm,
} from "./image-picker-template.ts";

/** One editor's picker: the cloned picker's parts and the library its grid
 *  shows. */
interface Picker extends PickerParts {
  editor: () => EditorView;
  library: ImageLibrary;
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

/** The window's close gives the caret back to the editor. */
const chooseImage = (picker: Picker, choice: ImageChoice): void => {
  if (!picker.editor().isDestroyed) insertImageRef(picker.editor(), choice);
  closeAdminModal(picker.key);
};

/** The page renders the picker only with image storage, so a library that
 *  cannot load is a real failure. Show a note and let the operator retry. */
const openPicker = async (picker: Picker): Promise<void> => {
  // A destroyed editor's view cannot dispatch, and the teardown leaves the
  // button mounted: the control stays inert.
  if (picker.editor().isDestroyed) return;
  // The page stays usable behind the window, so the button can press again.
  // A second press raises the window and keeps what it shows.
  if (!showPicker(picker, () => picker.editor().focus())) return;
  fillGrid(picker.grid, "loading", [noteFrom(picker.template, "loading")]);
  const options = await picker.library.load().catch(() => null);
  if (options === null) {
    if (isAdminModalOpen(picker.key)) {
      fillGrid(picker.grid, "ready", [noteFrom(picker.template, "loadFailed")]);
    }
    return;
  }
  // A window closed before the answer stays as it is.
  if (isAdminModalOpen(picker.key)) {
    fillGrid(
      picker.grid,
      "ready",
      imageOptionNodes(picker.template, options, (option, index) =>
        optionButton(option, index, () => chooseImage(picker, option)),
      ),
    );
  }
};

const wirePicker = (picker: Picker, button: HTMLButtonElement): void => {
  wireUploadForm(picker, (choice) => chooseImage(picker, choice));
  button.addEventListener("click", () => void openPicker(picker));
};

/** The image control: the element for the toolbar row and the plugin that
 *  binds the editor view and renders the image nodes. */
export interface ImageToolbarItem {
  element: HTMLElement;
  plugin: Plugin;
}

/** Build the toolbar's image control: the button and its picker. The picker's
 *  window belongs to the page, so the plugin-view recreations that the
 *  rich/raw toggle's state rebuild causes leave it open. */
export const createImageToolbarItem = (): ImageToolbarItem => {
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
    const picker: Picker = {
      ...clonePicker(template),
      editor: () => view,
      library,
    };
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
