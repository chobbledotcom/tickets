/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The image picker for the markdown editor toolbar: a modal dialog that
 * shows the site's image library as clickable thumbnails. It uploads new
 * images and inserts the short-form reference (`![Alt](img#id)`) at the
 * caret. The server translates img#id to the real image URL at render time,
 * so the editor stores the stable short form. The rich editor's image node
 * resolves the same short form through the library. The description box
 * then shows the picture while the markdown keeps the short form.
 */

import { schema } from "prosemirror-markdown";
import type { Node } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { ICONS_PATH } from "#shared/asset-paths.ts";
import { IMAGE_UPLOAD_ACCEPT } from "#shared/images/formats.ts";
import { createToolbarButton } from "#src/ui/client/admin/markdown-editor-toolbar.ts";
import {
  createButton,
  createElementWithClass,
  csrfTokenFor,
} from "#src/ui/client/dom.ts";

/** The image facts the dialog shows: the library entry's id and name, its
 * thumbnail URL for the grid, and its full URL for the editor. Every entry
 * carries all four. */
export interface ImageOption {
  id: number;
  name: string;
  thumb: string;
  url: string;
}

/** Keeps a malformed library entry out of the dialog: the entry needs an id
 * to reference, a name to insert, and a thumb to show. */
const isImageOption = (entry: unknown): entry is ImageOption => {
  if (typeof entry !== "object" || entry === null) return false;
  return (
    "id" in entry &&
    typeof entry.id === "number" &&
    "name" in entry &&
    typeof entry.name === "string" &&
    "thumb" in entry &&
    typeof entry.thumb === "string" &&
    "url" in entry &&
    typeof entry.url === "string"
  );
};

const EMPTY_MESSAGE = "No images uploaded yet.";
const UNAVAILABLE_MESSAGE = "Images are unavailable right now.";
const UPLOAD_FAILED_MESSAGE =
  "The image could not be uploaded. Please try again.";

/** From the ninth thumbnail on, the browser waits until the reader scrolls
 * near it, exactly as the images area's grid does. */
const LAZY_THUMBNAIL_FROM = 9;

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

/** The address the rich editor shows for a stored image source. A
 * short-form `img#N` resolves through the library to the image's URL, and
 * any other address renders as written. Null when the library lacks the
 * image or fails. The node then shows its alt text and requests nothing. */
const previewSource = async (
  loadOptions: () => Promise<ImageOption[]>,
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
  loadOptions: () => Promise<ImageOption[]>,
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

/** A muted one-line note (the empty, loading, and unavailable states). */
const mutedLine = (text: string): HTMLElement => {
  const line = createElementWithClass("p", "md-image-note");
  line.textContent = text;
  return line;
};

/** The dialog's close button: an × icon like the preview dialog's. */
const closeButton = (dialog: HTMLDialogElement): HTMLButtonElement => {
  const button = createButton("md-preview-close");
  button.setAttribute("aria-label", "Close image picker");
  button.innerHTML = `<svg class="icon" aria-hidden="true" focusable="false"><use href="${ICONS_PATH}#x"></use></svg>`;
  button.addEventListener("click", () => dialog.close());
  return button;
};

/** The upload form's facts: the field names the images area's upload posts,
 * and the label copy the images area shows. */
const UPLOAD_LABELS = {
  altText: "Alt text",
  file: "Image",
  heading: "Upload an image",
  name: "Name",
  submit: "Upload",
} as const;

/** The upload form: the same fields the images area's upload form has. The
 * submit is intercepted so the operator's unsaved description edits stay on
 * the page. A native POST navigates away and loses them. */
const uploadForm = (
  csrfToken: string,
  onUploaded: (id: number, name: string) => void,
  onFailed: () => void,
): HTMLFormElement => {
  const form = document.createElement("form");
  form.className = "md-image-upload";
  const heading = document.createElement("h3");
  heading.textContent = UPLOAD_LABELS.heading;
  const nameField = uploadField("name", UPLOAD_LABELS.name, "text", true);
  const altField = uploadField("alt_text", UPLOAD_LABELS.altText, "text");
  const fileField = uploadField("image", UPLOAD_LABELS.file, "file");
  fileField.querySelector<HTMLInputElement>('input[name="image"]')!.accept =
    IMAGE_UPLOAD_ACCEPT;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = UPLOAD_LABELS.submit;
  form.append(heading, nameField, altField, fileField, submit);

  /** The upload answers with a redirect to the new image's edit page. The
   * image id is the path segment that route carries. */
  const uploadedId = (url: string): number | null => {
    const match = /\/admin\/images\/(\d+)\/edit/.exec(new URL(url).pathname);
    return match === null ? null : Number(match[1]);
  };

  const nameInput = form.querySelector<HTMLInputElement>('input[name="name"]')!;
  const altInput = form.querySelector<HTMLInputElement>(
    'input[name="alt_text"]',
  )!;
  const fileInput = form.querySelector<HTMLInputElement>(
    'input[name="image"]',
  )!;

  form.addEventListener("submit", (event) => {
    // The dialog nests inside the page's own form: without this stop the
    // submit bubbles up and submits the page too.
    event.stopPropagation();
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    // The multipart body is built field by field onto a plain FormData. The
    // form itself lives in the editor bundle's document, and the file bytes
    // travel as a native Blob so the server sees the upload unchanged.
    void (async () => {
      const body = new FormData();
      body.append("csrf_token", csrfToken);
      body.append("name", nameInput.value);
      body.append("alt_text", altInput.value);
      const file = fileInput.files?.[0];
      if (file !== undefined && file !== null) {
        body.append(
          "image",
          new Blob([await file.arrayBuffer()], { type: file.type }),
          file.name,
        );
      }
      const response = await fetch("/admin/images", {
        body,
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`image upload responded ${response.status}`);
      }
      const id = uploadedId(response.url);
      if (id === null) {
        throw new Error("image upload responded without an image id");
      }
      onUploaded(id, nameInput.value);
    })().catch(() => {
      onFailed();
      submit.disabled = false;
    });
  });
  // A reset starts the form clean, so the next upload can submit again.
  form.addEventListener("reset", () => {
    submit.disabled = false;
  });
  return form;
};

/** One labelled upload field, wrapped as the images area wraps its fields. */
const uploadField = (
  name: string,
  label: string,
  type: "text" | "file",
  required = false,
): HTMLLabelElement => {
  const wrap = document.createElement("label");
  const input = document.createElement("input");
  input.type = type;
  input.name = name;
  if (required) input.required = true;
  wrap.append(label, input);
  return wrap;
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

  const dialog = document.createElement("dialog");
  dialog.className = "md-image-dialog";
  const heading = document.createElement("h2");
  heading.textContent = "Choose an image";
  const grid = createElementWithClass("div", "md-image-grid");
  dialog.append(closeButton(dialog), heading, grid);
  mount.append(dialog);

  // The option buttons dispatch through the editor view. The plugin's view
  // callback sets this during the EditorView constructor, before any click
  // can reach the dialog.
  let view: EditorView;

  // One fetch per mount, cached. A failed load is never cached, so the next
  // open retries. An upload resets the cache, so the next open shows the
  // newly uploaded image.
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
    grid.replaceChildren();
    if (loaded.length === 0) {
      grid.append(mutedLine(EMPTY_MESSAGE));
      return;
    }
    for (const [index, option] of loaded.entries()) {
      const item = createButton("md-image-option");
      item.title = option.name;
      const image = document.createElement("img");
      image.alt = "";
      image.loading = index >= LAZY_THUMBNAIL_FROM ? "lazy" : "eager";
      image.src = option.thumb;
      const name = createElementWithClass("span", "md-image-name");
      name.textContent = option.name;
      item.append(image, name);
      item.addEventListener("click", () => {
        insertImageRef(view, option);
        dialog.close();
      });
      grid.append(item);
    }
  };

  const settle = async (): Promise<void> => {
    try {
      const loaded = await loadOptions();
      if (!dialog.open) return;
      grid.dataset.state = "ready";
      renderOptions(loaded);
    } catch {
      // A failed load is never cached, so the next open retries.
      options = null;
      if (!dialog.open) return;
      grid.dataset.state = "error";
      grid.replaceChildren(mutedLine(UNAVAILABLE_MESSAGE));
    }
  };

  const upload = uploadForm(
    csrfTokenFor(textarea),
    (id, name) => {
      // The library changed under the cached list: the next open refetches.
      options = null;
      // The upload resets the library cache, so the node view's own lookup
      // fetches the new image's URL when it renders.
      insertImageRef(view, { id, name, thumb: "", url: "" });
      // The next open offers a clean form, ready for another upload.
      upload.reset();
      dialog.close();
    },
    () => {
      grid.replaceChildren(mutedLine(UPLOAD_FAILED_MESSAGE));
    },
  );
  dialog.append(upload);

  // Clicking the backdrop (the dialog element itself) closes, as the preview
  // dialog does. Escape closes through the native cancel path. Either way
  // the caret goes back to the editor, so the operator can keep writing.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  for (const event of ["close", "cancel"]) {
    dialog.addEventListener(event, () => view.focus());
  }

  button.addEventListener("click", () => {
    // While the modal dialog is open its backdrop swallows clicks, so the
    // button only ever opens. A destroyed editor's view cannot dispatch,
    // and the teardown leaves the button mounted: the control stays inert.
    if (view.isDestroyed) return;
    grid.dataset.state = "loading";
    grid.replaceChildren(mutedLine("Loading…"));
    dialog.showModal();
    void settle();
  });

  // The plugin binds the editor view: the dialog rides the mount, so it
  // needs no teardown of its own. ProseMirror stores whatever the view
  // callback returns and probes it for update/destroy, so that value must
  // be an object. The plugin's image node view renders the picture a
  // stored short-form reference names. It resolves through the same
  // library cache the dialog uses. The document keeps the short form, so
  // the markdown serializes unchanged.
  const plugin = new Plugin({
    props: {
      nodeViews: {
        image: (node) => createImageNodeView(loadOptions, node),
      },
    },
    view: (editorView) => {
      view = editorView;
      return {};
    },
  });

  return { element: button, plugin };
};
