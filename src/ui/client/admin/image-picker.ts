/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The shared admin image picker: a modal dialog over the site's image
 * library, with an inline upload form. Single mode hands back the picture the
 * operator clicks. Multiple mode lets them mark several, then confirm.
 *
 * The markdown editor opens it from its toolbar, and the new-listing form
 * opens it from the Images field. The dialog lives inside the caller's mount,
 * so it goes away with the control that opened it.
 */

import { ICONS_PATH } from "#shared/asset-paths.ts";
import { IMAGE_UPLOAD_ACCEPT } from "#shared/images/formats.ts";
import type { ImagePickerOption } from "#shared/images/picker.ts";
import {
  createButton,
  createElementWithClass,
  createThumbnail,
  csrfTokenFor,
  setText,
} from "#src/ui/client/dom.ts";

export type ImagePickerMode = "multiple" | "single";

export interface ImagePickerConfig {
  /** Whether the caller can open it now. A destroyed editor cannot. */
  canOpen?: (() => boolean) | undefined;
  /** The element whose form holds the CSRF token the upload posts. */
  csrfSource: Element;
  mode: ImagePickerMode;
  /** Where the dialog lives, so it dies with the control that opens it. */
  mount: HTMLElement;
  /** The chosen pictures, in the order the operator chose them. */
  onChoose: (options: readonly ImagePickerOption[]) => void;
  /** Runs when the dialog closes, however it closes. */
  onClose?: (() => void) | undefined;
  /** The pictures already chosen, marked when the dialog opens. */
  selected?: (() => readonly ImagePickerOption[]) | undefined;
  title: string;
}

export interface ImagePicker {
  /** The library list through the dialog's cache. A caller that renders a
   *  stored short-form reference reuses it. */
  loadOptions: () => Promise<readonly ImagePickerOption[]>;
  open: () => void;
}

const EMPTY_MESSAGE = "No images uploaded yet.";
const UNAVAILABLE_MESSAGE = "Images are unavailable right now.";
const UPLOAD_FAILED_MESSAGE =
  "The image could not be uploaded. Please try again.";
const LOADING_MESSAGE = "Loading…";
const CHOOSE_MESSAGE = "Add images";

/** From the ninth thumbnail on, the browser waits until the reader scrolls
 *  near it, exactly as the images area's grid does. */
const LAZY_THUMBNAIL_FROM = 9;

/** The upload form's facts: the field names the images area's upload posts,
 *  and the label copy the images area shows. */
const UPLOAD_LABELS = {
  altText: "Alt text",
  file: "Image",
  heading: "Upload an image",
  name: "Name",
  submit: "Upload",
} as const;

/** Keeps a malformed library entry out of the dialog: the entry needs an id
 *  to reference, a name to show, and both addresses to render. */
const isImageOption = (entry: unknown): entry is ImagePickerOption => {
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

/** A muted one-line note (the empty, loading, and unavailable states). */
const mutedLine = (text: string): HTMLElement => {
  const line = createElementWithClass("p", "image-picker-note");
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

/** Wrap one upload control in its label. */
const uploadControl = (
  label: string,
  input: HTMLInputElement | HTMLTextAreaElement,
  name: string,
  required = false,
): HTMLLabelElement => {
  const wrap = document.createElement("label");
  input.name = name;
  if (required) input.required = true;
  wrap.append(label, input);
  return wrap;
};

/** One labelled upload field, wrapped as the images area wraps its fields. */
const uploadField = (
  name: string,
  label: string,
  type: "text" | "file",
  required = false,
): HTMLLabelElement => {
  const input = document.createElement("input");
  input.type = type;
  return uploadControl(label, input, name, required);
};

/** The alt text box: a textarea, because alt text can run past one line. */
const uploadTextArea = (name: string, label: string): HTMLLabelElement => {
  const input = document.createElement("textarea");
  input.rows = 3;
  return uploadControl(label, input, name);
};

/** The upload answers with a redirect to the new image's edit page. The image
 *  id is the path segment that route carries. */
const uploadedId = (url: string): number | null => {
  const match = /\/admin\/images\/(\d+)\/edit/.exec(new URL(url).pathname);
  return match === null ? null : Number(match[1]);
};

/** A heading element carrying its text. */
const headingElement = (tag: "h2" | "h3", text: string): HTMLHeadingElement => {
  const heading = document.createElement(tag);
  heading.textContent = text;
  return heading;
};

/** The upload form: the same fields the images area's upload form has. The
 *  submit is intercepted so the operator's unsaved page edits stay put. */
const uploadForm = (
  csrfToken: string,
  onUploaded: (id: number, name: string) => void,
  onFailed: () => void,
): HTMLFormElement => {
  const form = createElementWithClass(
    "form",
    "image-picker-upload",
  ) as HTMLFormElement;
  const heading = headingElement("h3", UPLOAD_LABELS.heading);
  const nameField = uploadField("name", UPLOAD_LABELS.name, "text", true);
  const altField = uploadTextArea("altText", UPLOAD_LABELS.altText);
  const fileField = uploadField("image", UPLOAD_LABELS.file, "file");
  fileField.querySelector<HTMLInputElement>('input[name="image"]')!.accept =
    IMAGE_UPLOAD_ACCEPT;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = UPLOAD_LABELS.submit;
  form.append(heading, nameField, altField, fileField, submit);

  const nameInput = form.querySelector<HTMLInputElement>('input[name="name"]')!;
  const altInput = form.querySelector<HTMLTextAreaElement>(
    'textarea[name="altText"]',
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
      body.append("csrfToken", csrfToken);
      body.append("name", nameInput.value);
      body.append("altText", altInput.value);
      const file = fileInput.files?.[0];
      if (file !== undefined) {
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

/** Build the image picker dialog. The caller owns the button that calls
 *  {@link ImagePicker.open}. */
export const createImagePicker = (config: ImagePickerConfig): ImagePicker => {
  const dialog = createElementWithClass(
    "dialog",
    "image-picker-dialog",
  ) as HTMLDialogElement;
  const heading = headingElement("h2", config.title);
  const grid = createElementWithClass("div", "image-picker-grid");
  const columns = createElementWithClass("div", "image-picker-columns");
  const selection = createElementWithClass("div", "image-picker-selection");
  selection.append(grid);
  dialog.append(closeButton(dialog), heading);

  // In multiple mode the operator marks pictures first, then confirms. In
  // single mode a click is the choice, so there is nothing to confirm.
  const confirm =
    config.mode === "multiple" ? createButton("image-picker-confirm") : null;
  if (confirm !== null) {
    confirm.textContent = CHOOSE_MESSAGE;
    selection.append(confirm);
  }

  /** The library's answer, cached per mount. A failed load is never cached. */
  let options: Promise<readonly ImagePickerOption[]> | null = null;
  /** The facts each chosen id shows, even when the library read fails. */
  const known = new Map<number, ImagePickerOption>();
  /** The chosen pictures, in the order the operator chose them. */
  let chosen: ImagePickerOption[] = [];

  const remember = (list: readonly ImagePickerOption[]): void => {
    for (const option of list) known.set(option.id, option);
  };

  const confirmState = (): void => {
    if (confirm === null) return;
    confirm.disabled = chosen.length === 0;
  };

  const isChosen = (id: number): boolean =>
    chosen.some((option) => option.id === id);

  const toggle = (option: ImagePickerOption): void => {
    chosen = isChosen(option.id)
      ? chosen.filter((carried) => carried.id !== option.id)
      : [...chosen, option];
    confirmState();
  };

  const fetchOptions = async (): Promise<readonly ImagePickerOption[]> => {
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

  const loadOptions = (): Promise<readonly ImagePickerOption[]> => {
    options ??= fetchOptions();
    return options;
  };

  const syncButton = (
    button: HTMLButtonElement,
    option: ImagePickerOption,
  ): void => {
    if (config.mode === "multiple") {
      button.setAttribute("aria-pressed", String(isChosen(option.id)));
    }
  };

  const renderOptions = (loaded: readonly ImagePickerOption[]): void => {
    remember(loaded);
    grid.replaceChildren();
    if (loaded.length === 0) {
      grid.append(mutedLine(EMPTY_MESSAGE));
      return;
    }
    for (const [index, option] of loaded.entries()) {
      const item = createButton("image-picker-option");
      item.title = option.name;
      syncButton(item, option);
      const image = createThumbnail(
        option.thumb,
        index >= LAZY_THUMBNAIL_FROM ? "lazy" : "eager",
      );
      const name = setText(
        createElementWithClass("span", "image-picker-name"),
        option.name,
      );
      item.append(image, name);
      item.addEventListener("click", () => {
        if (config.mode === "single") {
          config.onChoose([option]);
          dialog.close();
          return;
        }
        toggle(option);
        syncButton(item, option);
      });
      grid.append(item);
    }
  };

  const resetGrid = (): void => {
    grid.dataset.state = "loading";
    grid.replaceChildren(mutedLine(LOADING_MESSAGE));
  };

  const settle = async (): Promise<void> => {
    try {
      const loaded = await loadOptions();
      if (!dialog.open) return;
      grid.dataset.state = "ready";
      renderOptions(loaded);
      confirmState();
    } catch {
      // A failed load is never cached, so the next open retries.
      options = null;
      if (!dialog.open) return;
      grid.dataset.state = "error";
      grid.replaceChildren(mutedLine(UNAVAILABLE_MESSAGE));
    }
  };

  const upload = uploadForm(
    csrfTokenFor(config.csrfSource),
    (id, name) => {
      // The library changed under the cached list: the next read refetches.
      options = null;
      const uploaded = { id, name, thumb: "", url: "" };
      remember([uploaded]);
      if (config.mode === "single") {
        config.onChoose([uploaded]);
        upload.reset();
        dialog.close();
        return;
      }
      if (!isChosen(id)) chosen = [...chosen, uploaded];
      confirmState();
      upload.reset();
      resetGrid();
      void settle();
    },
    () => {
      grid.replaceChildren(mutedLine(UPLOAD_FAILED_MESSAGE));
    },
  );
  // The upload tools sit in the left column. The library and its confirm
  // button sit in the right column.
  columns.append(upload, selection);
  dialog.append(columns);
  if (confirm !== null) {
    confirm.addEventListener("click", () => {
      config.onChoose(chosen.map((option) => known.get(option.id)!));
      dialog.close();
    });
  }

  // Clicking the backdrop (the dialog element itself) closes, as the preview
  // dialog does. Escape closes through the native cancel path.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  for (const event of ["close", "cancel"]) {
    dialog.addEventListener(event, () => config.onClose?.());
  }
  config.mount.append(dialog);

  const open = (): void => {
    if (config.canOpen !== undefined && !config.canOpen()) return;
    const seed = config.selected?.() ?? [];
    chosen = [...seed];
    remember(seed);
    confirmState();
    resetGrid();
    dialog.showModal();
    void settle();
  };

  return {
    loadOptions,
    open,
  };
};
