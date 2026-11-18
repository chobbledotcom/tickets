/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The image picker for the markdown editor toolbar. The shared dialog shows
 * the site's image library as clickable thumbnails, and a click inserts the
 * short-form reference (`![Alt](img#id)`) at the caret. The server translates
 * img#id to the real image URL at render time, so the editor stores the
 * stable short form. The rich editor's image node resolves the same short
 * form through the library. The description box then shows the picture while
 * the markdown keeps the short form.
 */

import { schema } from "prosemirror-markdown";
import type { Node } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import type { ImagePickerOption } from "#shared/images/picker.ts";
import { createToolbarButton } from "#src/ui/client/admin/markdown-editor-toolbar.ts";
import { createImagePicker } from "./image-picker.ts";

/** Insert the short-form image reference at the caret and refocus. */
const insertImageRef = (view: EditorView, option: ImagePickerOption): void => {
  view.dispatch(
    view.state.tr
      .replaceSelectionWith(
        schema.nodes.image.create({
          alt: option.name,
          src: `img#${option.id}`,
        }),
      )
      .scrollIntoView(),
  );
  view.focus();
};

/** The address the rich editor shows for a stored image source. A
 * short-form `img#N` resolves through the library to the image's URL, and
 * any other address renders as written. Null when the library lacks the
 * image or fails. The node then shows its alt text and requests nothing. */
const previewSource = async (
  loadOptions: () => Promise<readonly ImagePickerOption[]>,
  src: string,
): Promise<string | null> => {
  const shortForm = /^img#(\d+)$/.exec(src);
  if (shortForm === null) return src;
  const id = Number(shortForm[1]);
  try {
    const options = await loadOptions();
    return options.find((option) => option.id === id)?.url ?? null;
  } catch {
    return null;
  }
};

/** The rich editor's image node: renders the picture a stored reference
 * names. The document keeps the short form, so the markdown serializes back
 * unchanged. */
const createImageNodeView = (
  loadOptions: () => Promise<readonly ImagePickerOption[]>,
  node: Node,
): NodeView => {
  const image = document.createElement("img");
  // The markdown image spec is draggable. The default rendering sets the
  // attribute, so a node view must too.
  image.draggable = true;
  // Guards against an older library answer landing after a newer node state.
  let generation = 0;
  const sync = async (next: Node): Promise<void> => {
    generation += 1;
    const current = generation;
    image.alt = typeof next.attrs.alt === "string" ? next.attrs.alt : "";
    const title = next.attrs.title;
    if (typeof title === "string" && title !== "") image.title = title;
    else image.removeAttribute("title");
    const src = await previewSource(loadOptions, String(next.attrs.src));
    if (current !== generation) return;
    if (src === null) image.removeAttribute("src");
    else image.setAttribute("src", src);
  };
  void sync(node);
  return {
    dom: image,
    // A node view keyed by type only ever receives nodes of that type.
    update: (next) => {
      void sync(next);
      return true;
    },
  };
};

/** The image control: the element for the toolbar row and the view plugin
 * that tears the dialog down with the editor. */
export interface ImageToolbarItem {
  element: HTMLElement;
  plugin: Plugin;
}

/** Build the toolbar's image control: the button and its modal dialog. The
 * dialog lives inside the editor's mount, so it dies with the editor and
 * survives the plugin-view recreations the rich/raw toggle's state rebuild
 * causes. */
export const createImageToolbarItem = (
  textarea: HTMLTextAreaElement,
  mount: HTMLElement,
): ImageToolbarItem => {
  const button = createToolbarButton(
    "md-toolbar-button md-toolbar-image",
    "Image",
    "Insert image",
  );
  // The layout marks the page when no image storage is configured. The
  // control hides rather than offering a picker that cannot store anything.
  button.hidden =
    document.documentElement.getAttribute("data-image-storage") === "off";
  button.setAttribute("aria-haspopup", "dialog");

  // The option buttons dispatch through the editor view. The plugin's view
  // callback sets this during the EditorView constructor, before any click
  // can reach the dialog.
  let view: EditorView;

  const picker = createImagePicker({
    canOpen: () => !view.isDestroyed,
    csrfSource: textarea,
    mode: "single",
    mount,
    onChoose: (options) => {
      const option = options[0];
      if (option !== undefined) insertImageRef(view, option);
    },
    // Escape and the backdrop both return the caret to the editor.
    onClose: () => view.focus(),
    title: "Choose an image",
  });

  button.addEventListener("click", () => picker.open());

  // The plugin binds the editor view and renders the picture a stored
  // short-form reference names. It resolves through the same library cache
  // the dialog uses. The document keeps the short form, so the markdown
  // serializes unchanged.
  const plugin = new Plugin({
    props: {
      nodeViews: {
        image: (node) => createImageNodeView(picker.loadOptions, node),
      },
    },
    view: (editorView) => {
      view = editorView;
      return {};
    },
  });

  return { element: button, plugin };
};
