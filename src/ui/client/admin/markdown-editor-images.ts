/// <reference lib="dom" />
/**
 * The image dropdown for the markdown editor toolbar: lists the site's
 * existing images by name and inserts the short-form reference
 * (`![Alt](img#id)`) at the caret. The server translates img#id to the real
 * image URL at render time, so the editor stores the stable short form.
 */

import { schema } from "prosemirror-markdown";
import type { EditorView } from "prosemirror-view";
import { createToolbarButton } from "#src/ui/client/admin/markdown-editor-toolbar.ts";
import { createButton, createElementWithClass } from "#src/ui/client/dom.ts";

/** The image facts the dropdown shows: the library entry's id and name. */
export interface ImageOption {
  id: number;
  name: string;
}

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

/** Build the toolbar's image control: the button and its dropdown panel. */
export const createImageToolbarItem = (view: EditorView): HTMLElement => {
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
  button.addEventListener("click", () => {
    if (panel.hidden) open();
    else close();
  });

  control.append(button, panel);

  // A click anywhere outside the control closes the panel. While the panel
  // is hidden the permanent listener is a cheap no-op.
  document.addEventListener("click", (event) => {
    if (!panel.hidden && !control.contains(event.target as Node)) close();
  });

  // One fetch per mount, cached. A failed load is never cached, so the next
  // open retries.
  let options: Promise<ImageOption[]> | null = null;
  const loadOptions = (): Promise<ImageOption[]> => {
    options ??= fetch("/admin/images/options")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`image options responded ${response.status}`);
        }
        return response.json() as Promise<{ images: ImageOption[] }>;
      })
      .then(({ images }) => images);
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

  const open = (): void => {
    panel.hidden = false;
    panel.dataset.state = "loading";
    panel.replaceChildren(mutedLine("Loading…"));
    loadOptions().then(
      (loaded) => {
        if (panel.hidden) return;
        panel.dataset.state = "ready";
        renderOptions(loaded);
      },
      () => {
        options = null;
        if (panel.hidden) return;
        panel.dataset.state = "error";
        panel.replaceChildren(mutedLine(UNAVAILABLE_MESSAGE));
      },
    );
  };

  const close = (): void => {
    panel.hidden = true;
  };

  return control;
};
