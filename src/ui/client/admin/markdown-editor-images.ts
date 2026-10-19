/// <reference lib="dom" />
/**
 * The image dropdown for the markdown editor toolbar: lists the site's
 * existing images by name and inserts the short-form reference
 * (`![Alt](img#id)`) at the caret. The server translates img#id to the real
 * image URL at render time, so the editor stores the stable short form.
 */

import { schema } from "prosemirror-markdown";
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { createToolbarButton } from "#src/ui/client/admin/markdown-editor-toolbar.ts";
import { createButton, createElementWithClass } from "#src/ui/client/dom.ts";

/** The image facts the dropdown shows: the library entry's id and name. */
export interface ImageOption {
  id: number;
  name: string;
}

/** Keeps a malformed library entry out of the dropdown: the entry needs an
 * id to reference and a name to show. */
const isImageOption = (entry: unknown): entry is ImageOption => {
  if (typeof entry !== "object" || entry === null) return false;
  return (
    "id" in entry &&
    typeof entry.id === "number" &&
    "name" in entry &&
    typeof entry.name === "string"
  );
};

const EMPTY_MESSAGE = "No images uploaded yet.";
const UNAVAILABLE_MESSAGE = "Images are unavailable right now.";

/** Insert the short-form image reference at the caret and refocus. */
const insertImageRef = (view: EditorView, option: ImageOption): void => {
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

/** A muted one-line panel note (the empty and unavailable states). */
const mutedLine = (text: string): HTMLElement => {
  const line = createElementWithClass("p", "md-image-dropdown-note");
  line.textContent = text;
  return line;
};

/** The image control: the element for the toolbar row and the view plugin
 * that tears the dropdown down with the editor. */
export interface ImageToolbarItem {
  element: HTMLElement;
  plugin: Plugin;
}

/** Build the toolbar's image control: the button and its dropdown panel. */
export const createImageToolbarItem = (): ImageToolbarItem => {
  const control = document.createElement("span");
  control.className = "md-image-control";

  const panel = document.createElement("div");
  panel.className = "md-image-dropdown";
  panel.hidden = true;

  const button = createToolbarButton(
    "md-toolbar-button md-toolbar-image",
    "Image",
    "Insert image",
  );
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    if (panel.hidden) open();
    else close();
  });

  control.append(button, panel);

  // The option buttons dispatch through the editor view. The plugin's view
  // callback sets this during the EditorView constructor, before any click
  // can reach the panel.
  let view: EditorView;

  // One fetch per mount, cached. A failed load is never cached, so the next
  // open retries.
  let options: Promise<ImageOption[]> | null = null;
  const fetchOptions = async (): Promise<ImageOption[]> => {
    const response = await fetch("/admin/images/options");
    if (!response.ok) {
      throw new Error(`image options responded ${response.status}`);
    }
    const body = (await response.json()) as { images: unknown };
    if (!Array.isArray(body.images)) {
      throw new Error("image options responded without an images array");
    }
    return body.images.map((entry) => {
      if (!isImageOption(entry)) {
        throw new Error("image options responded with a malformed entry");
      }
      return entry;
    });
  };
  const loadOptions = (): Promise<ImageOption[]> => {
    options ??= fetchOptions();
    return options;
  };

  const renderOptions = (loaded: ImageOption[]): void => {
    panel.replaceChildren();
    if (loaded.length === 0) {
      panel.append(mutedLine(EMPTY_MESSAGE));
      return;
    }
    for (const option of loaded) {
      const item = createButton("md-image-option");
      item.textContent = option.name;
      item.addEventListener("click", () => {
        insertImageRef(view, option);
        close();
      });
      panel.append(item);
    }
  };

  const settle = async (): Promise<void> => {
    try {
      const loaded = await loadOptions();
      if (panel.hidden) return;
      panel.dataset.state = "ready";
      renderOptions(loaded);
    } catch {
      // A failed load is never cached, so the next open retries.
      options = null;
      if (panel.hidden) return;
      panel.dataset.state = "error";
      panel.replaceChildren(mutedLine(UNAVAILABLE_MESSAGE));
    }
  };

  // A click anywhere outside the control closes the panel. Escape closes it
  // and returns focus to the button. Both listeners live only while the
  // panel is open.
  const onDocumentClick = (event: Event): void => {
    if (!control.contains(event.target as Node)) close();
  };
  const onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      close();
      button.focus();
    }
  };

  const open = (): void => {
    // A destroyed editor's view cannot dispatch, and the teardown leaves
    // the button mounted: the control stays inert.
    if (view.isDestroyed) return;
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onDocumentKeydown);
    panel.dataset.state = "loading";
    panel.replaceChildren(mutedLine("Loading…"));
    void settle();
  };

  const close = (): void => {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocumentClick);
    document.removeEventListener("keydown", onDocumentKeydown);
  };

  // EditorView.destroy() destroys plugin views, so this destroy runs when
  // the editor is destroyed and closes the panel even if it is still open.
  // A destroyed editor leaves no document listeners behind.
  const plugin = new Plugin({
    view: (editorView) => {
      view = editorView;
      return { destroy: close };
    },
  });

  return { element: control, plugin };
};
