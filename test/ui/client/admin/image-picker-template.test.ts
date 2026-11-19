/**
 * The shared image picker template
 * (`src/ui/client/admin/image-picker-template.ts`): the direct test mirror
 * for the clone, the grid, the close paths, and the upload POST.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  IMAGE_LIBRARY_CHANGED,
  type ImageChoice,
} from "#shared/images/picker.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  clonePickerDialog,
  fillGrid,
  imageOptionNodes,
  noteFrom,
  optionButton,
  type PickerDialogParts,
  pickerTemplateOrNull,
  wireDialogClose,
  wireUploadForm,
} from "#src/ui/client/admin/image-picker-template.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { requireElement } from "#test-utils/happy-dom.ts";
import {
  cleanup,
  installDom,
  PICKER_CSRF_TOKEN,
  PICKER_TEMPLATE,
} from "#test-utils/markdown-editor-dom.ts";
import {
  fetchStubHolder,
  flush,
  redirected,
  restoreHeldStub,
} from "#test-utils/markdown-image-dialog.ts";

afterEach(cleanup);
afterEach(restoreHeldStub);

const ALPHA = {
  full: "/image/alpha.webp",
  id: 2,
  name: "Alpha",
  thumb: "/image/alpha-thumb.webp",
};

/** The real template and one cloned dialog. */
const parts = (): PickerDialogParts & { template: HTMLTemplateElement } => {
  const template = requireValue(pickerTemplateOrNull(), "picker template");
  return { ...clonePickerDialog(template, document.body), template };
};

const nameInput = (dialog: PickerDialogParts): HTMLInputElement =>
  requireElement<HTMLInputElement>(dialog.form, 'input[name="name"]');

/** Fill the dialog's grid with one option and submit the upload form. */
const submit = async (
  dialog: PickerDialogParts,
  name = "Harbour",
): Promise<void> => {
  nameInput(dialog).value = name;
  dialog.form.requestSubmit();
  await flush();
};

describe("the image picker template", () => {
  test("finds the server's template and one of its notes", () => {
    installDom(PICKER_TEMPLATE);
    const template = requireValue(pickerTemplateOrNull(), "picker template");

    expect(template.id).toBe("md-image-picker");
    expect(noteFrom(template, "loadFailed").textContent).toBe(
      "The image library could not load. Please try again.",
    );
  });

  test("builds one option button with its pressed state", () => {
    installDom(PICKER_TEMPLATE);
    let picked = 0;
    const button = optionButton(
      ALPHA,
      9,
      () => {
        picked += 1;
      },
      true,
    );

    expect(button.title).toBe("Alpha");
    expect(button.textContent).toBe("Alpha");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.querySelector("img")?.getAttribute("loading")).toBe("lazy");
    expect(button.querySelector("img")?.getAttribute("src")).toBe(
      "/image/alpha-thumb.webp",
    );
    button.click();
    expect(picked).toBe(1);
  });

  test("lists the options, or the empty note", () => {
    installDom(PICKER_TEMPLATE);
    const { template } = parts();

    const empty = imageOptionNodes(template, [], () => null as never);
    expect((empty[0] as HTMLElement).textContent).toBe("No images yet.");
    const nodes = imageOptionNodes(template, [ALPHA], (option, index) =>
      optionButton(option, index, () => undefined),
    );
    expect(nodes).toHaveLength(1);
    expect((nodes[0] as HTMLElement).textContent).toBe("Alpha");
  });

  test("clones the dialog's named parts", () => {
    installDom(PICKER_TEMPLATE);
    const dialog = parts();

    expect(dialog.dialog.className).toBe("md-image-dialog");
    expect(dialog.grid.className).toBe("md-image-grid");
    expect(dialog.name.name).toBe("name");
    expect(dialog.submit.type).toBe("submit");
  });

  test("puts a state and its content into the grid", () => {
    installDom(PICKER_TEMPLATE);
    const { grid } = parts();

    fillGrid(grid, "ready", [document.createElement("p")]);
    expect(grid.dataset.state).toBe("ready");
    expect(grid.children).toHaveLength(1);
  });

  test("closes from the close button and the backdrop", () => {
    installDom(PICKER_TEMPLATE);
    const dialog = parts();
    let closes = 0;
    wireDialogClose(dialog.dialog, () => {
      closes += 1;
    });

    dialog.dialog.showModal();
    requireElement<HTMLButtonElement>(
      dialog.dialog,
      ".md-preview-close",
    ).click();
    expect(dialog.dialog.open).toBe(false);

    dialog.dialog.showModal();
    dialog.dialog.click();
    expect(dialog.dialog.open).toBe(false);
    expect(closes).toBe(2);
  });

  test("keeps the dialog open during an upload and announces the change", async () => {
    installDom(PICKER_TEMPLATE);
    const dialog = parts();
    const { promise: upload, resolve: resolveUpload } =
      Promise.withResolvers<Response>();
    fetchStubHolder.stub = stubFetch(() => upload);
    const uploaded: ImageChoice[] = [];
    let changes = 0;
    document.addEventListener(IMAGE_LIBRARY_CHANGED, () => {
      changes += 1;
    });
    wireUploadForm(dialog, (choice) => {
      uploaded.push(choice);
    });
    wireDialogClose(dialog.dialog, () => undefined);
    dialog.dialog.showModal();

    await submit(dialog);
    expect(dialog.submit.disabled).toBe(true);
    requireElement<HTMLButtonElement>(
      dialog.dialog,
      ".md-preview-close",
    ).click();
    expect(dialog.dialog.open).toBe(true);
    dialog.dialog.click();
    expect(dialog.dialog.open).toBe(true);
    const cancel = new Event("cancel", { cancelable: true });
    dialog.dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);

    resolveUpload(redirected("/admin/images/12/edit"));
    await flush();

    expect(uploaded).toEqual([{ id: 12, name: "Harbour" }]);
    expect(changes).toBe(1);
    expect(nameInput(dialog).value).toBe("");
    expect(dialog.submit.disabled).toBe(false);
    requireElement<HTMLButtonElement>(
      dialog.dialog,
      ".md-preview-close",
    ).click();
    expect(dialog.dialog.open).toBe(false);
  });

  test("keeps the grid and shows the upload failure note", async () => {
    installDom(PICKER_TEMPLATE);
    const dialog = parts();
    fillGrid(dialog.grid, "ready", [optionButton(ALPHA, 0, () => undefined)]);
    fetchStubHolder.stub = stubFetch(new Response("refused", { status: 500 }));
    wireUploadForm(dialog, () => undefined);
    const bodySubmits: Event[] = [];
    document.body.addEventListener("submit", (event) => {
      bodySubmits.push(event);
    });
    const seen: { event: Event | null } = { event: null };
    dialog.form.addEventListener("submit", (event) => {
      seen.event = event;
    });

    await submit(dialog);

    expect(seen.event?.defaultPrevented).toBe(true);
    expect(bodySubmits).toEqual([]);
    expect(dialog.grid.dataset.state).toBe("ready");
    expect(dialog.grid.querySelector(".md-image-option")?.textContent).toBe(
      "Alpha",
    );
    expect(dialog.grid.textContent).toContain(
      "The image could not be uploaded. Please try again.",
    );
    expect(dialog.submit.disabled).toBe(false);
    expect({ ...dialog.dialog.dataset }).toEqual({});
  });

  test("refuses a redirect outside the image edit route", async () => {
    installDom(PICKER_TEMPLATE);
    const dialog = parts();
    fetchStubHolder.stub = stubFetch(redirected("/admin/images/12/edits"));
    let called = false;
    wireUploadForm(dialog, () => {
      called = true;
    });

    await submit(dialog);

    expect(called).toBe(false);
    expect(dialog.grid.textContent).toContain(
      "The image could not be uploaded. Please try again.",
    );
  });

  test("shows the server's refusal reason", async () => {
    installDom(PICKER_TEMPLATE);
    const dialog = parts();
    const refused = new Response(
      '<div class="error" role="alert">Image name is required</div>',
    );
    Object.defineProperty(refused, "url", {
      value: "http://localhost/admin/images/new",
    });
    fetchStubHolder.stub = stubFetch(refused);
    wireUploadForm(dialog, () => undefined);

    await submit(dialog);

    expect(dialog.grid.textContent).toBe("Image name is required");
  });

  test("uses the generic note for an empty server refusal", async () => {
    installDom(PICKER_TEMPLATE);
    const dialog = parts();
    const refused = new Response('<div class="error" role="alert"> </div>');
    Object.defineProperty(refused, "url", {
      value: "http://localhost/admin/images/new",
    });
    fetchStubHolder.stub = stubFetch(refused);
    wireUploadForm(dialog, () => undefined);

    await submit(dialog);

    expect(dialog.grid.textContent).toBe(
      "The image could not be uploaded. Please try again.",
    );
  });

  test("sends the chosen file's bytes with its name", async () => {
    installDom(PICKER_TEMPLATE);
    const dialog = parts();
    const form = dialog.form;
    const file = new File([new Uint8Array([1, 2, 3])], "harbour.png", {
      type: "image/png",
    });
    Object.defineProperty(
      requireElement<HTMLInputElement>(form, 'input[name="image"]'),
      "files",
      { value: [file] },
    );
    const sentRequest: {
      body: FormData | null;
      method: string | undefined;
    } = { body: null, method: undefined };
    fetchStubHolder.stub = stubFetch((_url, init) => {
      sentRequest.body = init?.body as FormData;
      sentRequest.method = init?.method;
      return redirected("/admin/images/12/edit");
    });
    wireUploadForm(dialog, () => undefined);

    await submit(dialog);

    expect(sentRequest.method).toBe("POST");
    expect(sentRequest.body?.get("csrfToken")).toBe(PICKER_CSRF_TOKEN);
    expect(sentRequest.body?.get("name")).toBe("Harbour");
    expect(sentRequest.body?.get("altText")).toBe("");
    const sent = sentRequest.body?.get("image");
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe("harbour.png");
    expect((sent as File).type).toBe("image/png");
    expect([...new Uint8Array(await (sent as File).arrayBuffer())]).toEqual([
      1, 2, 3,
    ]);
  });
});
