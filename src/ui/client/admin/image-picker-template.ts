/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The server-rendered image picker template, as the browser uses it. Both
 * the markdown editor and the new-listing form clone the same dialog. This
 * module owns the clone, the grid notes, and the upload POST.
 */

import {
  IMAGE_PICKER_ID,
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
export type GridState = "loading" | "ready";

/** The dialog's parts that both consumers drive. */
export interface PickerDialogParts {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  grid: HTMLElement;
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
 *  carries the name. */
export const optionButton = (
  option: ImageOption,
  index: number,
  onPick: () => void,
): HTMLButtonElement => {
  const item = createButton("md-image-option");
  item.title = option.name;
  const image = createThumbnail(
    option.thumb,
    index >= LAZY_THUMBNAIL_FROM ? "lazy" : "eager",
  );
  item.append(image, option.name);
  item.addEventListener("click", onPick);
  return item;
};

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
  return {
    dialog,
    form: requiredChild<HTMLFormElement>(dialog, "form"),
    grid: requiredChild<HTMLElement>(dialog, ".md-image-grid"),
  };
};

/** The dialog's close paths, so every close returns the caller to its own
 *  control. Clicking the backdrop closes, as the preview dialog does. Escape
 *  closes through the native cancel path. */
export const wireDialogClose = (
  dialog: HTMLDialogElement,
  onClose: () => void,
): void => {
  requiredChild(dialog, ".md-preview-close").addEventListener("click", () =>
    dialog.close(),
  );
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", onClose);
};

/** Adds one form field to the multipart body. A chosen file travels as a
 *  native Blob, so the server sees the upload unchanged. */
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

/** Posts the upload form's fields to its action and answers the new image's
 *  id. Only the redirect to the new image's edit page proves the upload. */
export const uploadImage = async (form: HTMLFormElement): Promise<number> => {
  const body = new FormData();
  for (const input of form.querySelectorAll("input")) {
    await appendField(body, input);
  }
  for (const textarea of form.querySelectorAll("textarea")) {
    body.append(textarea.name, textarea.value);
  }
  const response = await fetch(form.action, { body, method: "POST" });
  const match = /\/admin\/images\/(\d+)\/edit/.exec(
    new URL(response.url).pathname,
  );
  if (match === null) {
    throw new Error("image upload responded without an image id");
  }
  return Number(match[1]);
};

/** The new image's id. Null when the upload fails. */
export const uploadedIdOrNull = async (
  form: HTMLFormElement,
): Promise<number | null> => {
  try {
    return await uploadImage(form);
  } catch {
    // A refused file or a lost connection is an everyday failure. The
    // picker shows its note, and the operator can try again.
    return null;
  }
};
