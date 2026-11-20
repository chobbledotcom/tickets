/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The server-rendered image picker template, as the browser uses it. Both
 * the markdown editor and the new-listing form clone the same dialog. This
 * module owns the clone, the grid notes, and the upload POST.
 */

import {
  IMAGE_LIBRARY_CHANGED,
  IMAGE_PICKER_ID,
  type ImageChoice,
  type ImageOption,
  LAZY_THUMBNAIL_FROM,
  type PickerNote,
} from "#shared/images/picker.ts";
import {
  createButton,
  createThumbnail,
  requiredChild,
} from "#src/ui/client/dom.ts";

/** The grid's states, as `data-state` names them. */
type GridState = "loading" | "ready";

/** The dialog's parts that both consumers drive. */
export interface PickerDialogParts {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  grid: HTMLElement;
  name: HTMLInputElement;
  submit: HTMLButtonElement;
  /** The template the grid's notes come from. */
  template: HTMLTemplateElement;
}

/** The page's picker template. Null on a page without image storage. */
export const pickerTemplateOrNull = (): HTMLTemplateElement | null =>
  document.querySelector<HTMLTemplateElement>(`template#${IMAGE_PICKER_ID}`);

/** A fresh copy of one of the template's notes. */
export const noteFrom = (
  template: HTMLTemplateElement,
  note: PickerNote,
): Node =>
  document.importNode(
    requiredChild(template.content, `[data-note="${note}"]`),
    true,
  );

/** Puts the grid in a state and shows that state's content. */
export const fillGrid = (
  grid: HTMLElement,
  state: GridState,
  content: Node[],
): void => {
  grid.dataset.state = state;
  grid.replaceChildren(...content);
};

/** One thumbnail button. The thumbnail is decorative: the button's text
 *  carries the name. A marked button carries `aria-pressed`. */
export const optionButton = (
  option: ImageOption,
  index: number,
  onPick: () => void,
  pressed?: boolean,
): HTMLButtonElement => {
  const item = createButton("md-image-option");
  item.title = option.name;
  const image = createThumbnail(
    option.thumb,
    index >= LAZY_THUMBNAIL_FROM ? "lazy" : "eager",
  );
  item.append(image, option.name);
  if (pressed !== undefined) {
    item.setAttribute("aria-pressed", String(pressed));
  }
  item.addEventListener("click", onPick);
  return item;
};

/** The grid's option buttons, or the empty note for a library without
 *  images. */
export const imageOptionNodes = (
  template: HTMLTemplateElement,
  options: readonly ImageOption[],
  buttonFor: (option: ImageOption, index: number) => HTMLButtonElement,
): Node[] =>
  options.length === 0
    ? [noteFrom(template, "empty")]
    : options.map((option, index) => buttonFor(option, index));

/** Clones the template's dialog into `mount` and names its parts. */
export const clonePickerDialog = (
  template: HTMLTemplateElement,
  mount: HTMLElement,
): PickerDialogParts => {
  const dialog = document.importNode(
    requiredChild<HTMLDialogElement>(template.content, "dialog"),
    true,
  );
  mount.append(dialog);
  const form = requiredChild<HTMLFormElement>(dialog, "form");
  return {
    dialog,
    form,
    grid: requiredChild<HTMLElement>(dialog, ".md-image-grid"),
    name: requiredChild<HTMLInputElement>(form, 'input[name="name"]'),
    submit: requiredChild<HTMLButtonElement>(form, 'button[type="submit"]'),
    template,
  };
};

/** The dialog's close paths, so every close returns the caller to its own
 *  control. Clicking the backdrop closes, as the preview dialog does. Escape
 *  closes through the native cancel path. */
export const wireDialogClose = (
  dialog: HTMLDialogElement,
  onClose: () => void,
): void => {
  requiredChild(dialog, ".md-preview-close").addEventListener("click", () => {
    if (dialog.dataset.uploading !== "true") dialog.close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && dialog.dataset.uploading !== "true") {
      dialog.close();
    }
  });
  dialog.addEventListener("cancel", (event) => {
    if (dialog.dataset.uploading === "true") event.preventDefault();
  });
  dialog.addEventListener("close", onClose);
};

/** Adds one form field to the multipart body. A chosen file travels as a
 *  native File, so the server sees the upload unchanged. */
const appendField = (body: FormData, input: HTMLInputElement): void => {
  if (input.type !== "file") {
    body.append(input.name, input.value);
    return;
  }
  const file = input.files?.[0];
  if (file === undefined) return;
  body.append(input.name, file, file.name);
};

/** The server's refusal text from the page the upload redirect followed. */
const refusalMessage = async (response: Response): Promise<string | null> => {
  const template = document.createElement("template");
  template.innerHTML = await response.text();
  const message = template.content
    .querySelector(".error[role='alert']")
    ?.textContent?.trim();
  return message === undefined || message === "" ? null : message;
};

/** One upload's answer: the new image id, or the server's refusal. */
type UploadOutcome = { id: number } | { error: string | null };

/** Posts the upload form's fields to its action and answers the new image's
 *  id. Only the redirect to the new image's edit page proves the upload. */
const uploadImage = async (form: HTMLFormElement): Promise<UploadOutcome> => {
  const body = new FormData();
  for (const input of form.querySelectorAll("input")) {
    appendField(body, input);
  }
  for (const textarea of form.querySelectorAll("textarea")) {
    body.append(textarea.name, textarea.value);
  }
  const response = await fetch(form.action, { body, method: "POST" });
  const match = /^\/admin\/images\/(\d+)\/edit$/.exec(
    new URL(response.url).pathname,
  );
  if (match === null) return { error: await refusalMessage(response) };
  return { id: Number(match[1]) };
};

/** The upload's answer. A thrown request becomes a generic refusal. */
const uploadedIdOrNull = async (
  form: HTMLFormElement,
): Promise<UploadOutcome> => {
  try {
    return await uploadImage(form);
  } catch {
    // A lost connection is an everyday failure. The picker shows its note,
    // and the operator can try again.
    return { error: null };
  }
};

/** Wire the upload form that both pickers show. A submit stays on the page,
 *  because the dialog nests inside the page's own form. */
export const wireUploadForm = (
  parts: PickerDialogParts,
  onUploaded: (choice: ImageChoice) => void | Promise<void>,
): void => {
  parts.form.addEventListener("submit", (event) => {
    // Without this stop the submit bubbles up and submits the page too.
    event.stopPropagation();
    event.preventDefault();
    if (parts.submit.disabled) return;
    parts.submit.disabled = true;
    parts.dialog.dataset.uploading = "true";
    void (async () => {
      try {
        const name = parts.name.value;
        const result = await uploadedIdOrNull(parts.form);
        if ("error" in result) {
          parts.grid.dataset.state = "ready";
          parts.grid.querySelector('[data-note="uploadFailed"]')?.remove();
          const note = noteFrom(parts.template, "uploadFailed");
          if (result.error !== null) note.textContent = result.error;
          parts.grid.append(note);
          return;
        }
        // Every picker on the page must drop its cached list.
        document.dispatchEvent(new Event(IMAGE_LIBRARY_CHANGED));
        parts.form.reset();
        await onUploaded({ id: result.id, name });
      } finally {
        parts.submit.disabled = false;
        delete parts.dialog.dataset.uploading;
      }
    })();
  });
};
