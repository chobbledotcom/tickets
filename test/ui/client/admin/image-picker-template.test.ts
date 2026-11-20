/**
 * The shared image picker template
 * (`src/ui/client/admin/image-picker-template.ts`): the direct test mirror
 * for the clone, the window, the grid, and the upload POST.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  IMAGE_LIBRARY_CHANGED,
  type ImageChoice,
} from "#shared/images/picker.ts";
import { requireValue } from "#shared/required-value.ts";
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
} from "#src/ui/client/admin/image-picker-template.ts";
import { isAdminModalOpen } from "#src/ui/client/admin/modal.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { fireEvent, requireElement } from "#test-utils/happy-dom.ts";
import {
  ADMIN_TEMPLATES,
  cleanup,
  installDom,
  PICKER_CSRF_TOKEN,
} from "#test-utils/markdown-editor-dom.ts";
import {
  closeControl,
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

/** The real template and one cloned picker, on the page so that its form
 * can submit. */
const parts = (): PickerParts => {
  const picker = clonePicker(
    requireValue(pickerTemplateOrNull(), "picker template"),
  );
  document.body.append(picker.content);
  return picker;
};

const nameInput = (picker: PickerParts): HTMLInputElement =>
  requireElement<HTMLInputElement>(picker.form, 'input[name="name"]');

/** Fill the picker's name and submit the upload form. */
const submit = async (picker: PickerParts, name = "Harbour"): Promise<void> => {
  nameInput(picker).value = name;
  picker.form.requestSubmit();
  await flush();
};

/** The picker's open window. */
const windowOf = (picker: PickerParts): HTMLDialogElement =>
  requireElement<HTMLDialogElement>(
    document,
    `dialog[data-modal-key="${picker.key}"]`,
  );

const pressEscape = (target: HTMLElement): void =>
  fireEvent(
    target,
    new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
  );

/** The image edit page's refusal, carrying the given body. */
const refusal = (html: string): Response => {
  const refused = new Response(html);
  Object.defineProperty(refused, "url", {
    value: "http://localhost/admin/images/new",
  });
  return refused;
};

/** Answer the upload with a refused page, then return the picker. */
const refusedUpload = async (errorHtml: string): Promise<PickerParts> => {
  installDom(ADMIN_TEMPLATES);
  const picker = parts();
  fetchStubHolder.stub = stubFetch(refusal(errorHtml));
  wireUploadForm(picker, () => undefined);
  await submit(picker);
  return picker;
};

describe("the image picker template", () => {
  test("finds the server's template and one of its notes", () => {
    installDom(ADMIN_TEMPLATES);
    const template = requireValue(pickerTemplateOrNull(), "picker template");

    expect(template.id).toBe("md-image-picker");
    expect(noteFrom(template, "loadFailed").textContent).toBe(
      "The image library could not load. Please try again.",
    );
  });

  test("builds one option button with its pressed state", () => {
    installDom(ADMIN_TEMPLATES);
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
    installDom(ADMIN_TEMPLATES);
    const { template } = parts();

    const empty = imageOptionNodes(template, [], () => null as never);
    expect((empty[0] as HTMLElement).textContent).toBe("No images yet.");
    const nodes = imageOptionNodes(template, [ALPHA], (option, index) =>
      optionButton(option, index, () => undefined),
    );
    expect(nodes).toHaveLength(1);
    expect((nodes[0] as HTMLElement).textContent).toBe("Alpha");
  });

  test("clones the picker's named parts", () => {
    installDom(ADMIN_TEMPLATES);
    const picker = parts();

    expect(picker.content.className).toBe("md-image-picker");
    expect(picker.grid.className).toBe("md-image-grid");
    expect(picker.name.name).toBe("name");
    expect(picker.submit.type).toBe("submit");
    expect(picker.title).toBe("Choose an image");
  });

  test("gives each picker its own window name", () => {
    installDom(ADMIN_TEMPLATES);
    const [first, second] = [parts(), parts()];

    expect(first.key).toMatch(/^image-picker:\d+$/);
    expect(second.key).toMatch(/^image-picker:\d+$/);
    expect(second.key).not.toBe(first.key);
  });

  test("puts a state and its content into the grid", () => {
    installDom(ADMIN_TEMPLATES);
    const { grid } = parts();

    fillGrid(grid, "ready", [document.createElement("p")]);
    expect(grid.dataset.state).toBe("ready");
    expect(grid.children).toHaveLength(1);
  });

  test("opens the picker in a window and raises it when open", () => {
    installDom(ADMIN_TEMPLATES);
    const picker = parts();

    expect(isAdminModalOpen(picker.key)).toBe(false);
    expect(showPicker(picker, () => undefined)).toBe(true);
    const dialog = windowOf(picker);
    expect(dialog.open).toBe(true);
    expect(
      requireElement<HTMLElement>(dialog, ".admin-modal-title").textContent,
    ).toBe("Choose an image");
    expect(dialog.contains(picker.content)).toBe(true);

    // A second call opens nothing: the caller keeps what the window shows.
    expect(showPicker(picker, () => undefined)).toBe(false);
    expect(document.querySelectorAll("dialog.admin-modal")).toHaveLength(1);
  });

  test("shows the title that the caller names", () => {
    installDom(ADMIN_TEMPLATES);
    const picker = parts();

    showPicker(picker, () => undefined, "Choose pictures");

    expect(
      requireElement<HTMLElement>(windowOf(picker), ".admin-modal-title")
        .textContent,
    ).toBe("Choose pictures");
  });

  test("tells the caller once when the window closes", () => {
    installDom(ADMIN_TEMPLATES);
    const picker = parts();
    let closes = 0;
    showPicker(picker, () => {
      closes += 1;
    });

    closeControl(windowOf(picker)).click();

    expect(closes).toBe(1);
    expect(isAdminModalOpen(picker.key)).toBe(false);
  });

  test("keeps the window open during an upload and announces the change", async () => {
    installDom(ADMIN_TEMPLATES);
    const picker = parts();
    const { promise: upload, resolve: resolveUpload } =
      Promise.withResolvers<Response>();
    fetchStubHolder.stub = stubFetch(() => upload);
    const uploaded: ImageChoice[] = [];
    let changes = 0;
    document.addEventListener(IMAGE_LIBRARY_CHANGED, () => {
      changes += 1;
    });
    wireUploadForm(picker, (choice) => {
      uploaded.push(choice);
    });
    showPicker(picker, () => undefined);
    const dialog = windowOf(picker);

    await submit(picker);
    expect(picker.submit.disabled).toBe(true);
    closeControl(dialog).click();
    expect(dialog.open).toBe(true);
    pressEscape(dialog);
    expect(dialog.open).toBe(true);

    resolveUpload(redirected("/admin/images/12/edit"));
    await flush();

    expect(uploaded).toEqual([{ id: 12, name: "Harbour" }]);
    expect(changes).toBe(1);
    expect(nameInput(picker).value).toBe("");
    expect(picker.submit.disabled).toBe(false);
    closeControl(dialog).click();
    expect(dialog.open).toBe(false);
  });

  test("keeps the grid and shows the upload failure note", async () => {
    installDom(ADMIN_TEMPLATES);
    const picker = parts();
    fillGrid(picker.grid, "ready", [optionButton(ALPHA, 0, () => undefined)]);
    fetchStubHolder.stub = stubFetch(new Response("refused", { status: 500 }));
    wireUploadForm(picker, () => undefined);
    const seen: { event: Event | null } = { event: null };
    picker.form.addEventListener("submit", (event) => {
      seen.event = event;
    });

    await submit(picker);

    expect(seen.event?.defaultPrevented).toBe(true);
    expect(picker.grid.dataset.state).toBe("ready");
    expect(picker.grid.querySelector(".md-image-option")?.textContent).toBe(
      "Alpha",
    );
    expect(picker.grid.textContent).toContain(
      "The image could not be uploaded. Please try again.",
    );
    expect(picker.submit.disabled).toBe(false);
    expect({ ...picker.content.dataset }).toEqual({});
  });

  test("refuses a redirect outside the image edit route", async () => {
    installDom(ADMIN_TEMPLATES);
    const picker = parts();
    fetchStubHolder.stub = stubFetch(redirected("/admin/images/12/edits"));
    let called = false;
    wireUploadForm(picker, () => {
      called = true;
    });

    await submit(picker);

    expect(called).toBe(false);
    expect(picker.grid.textContent).toContain(
      "The image could not be uploaded. Please try again.",
    );
  });

  test("shows the server's refusal reason", async () => {
    const picker = await refusedUpload(
      '<div class="error" role="alert">Image name is required</div>',
    );

    expect(picker.grid.textContent).toBe("Image name is required");
  });

  test("uses the generic note for an empty server refusal", async () => {
    const picker = await refusedUpload(
      '<div class="error" role="alert"> </div>',
    );

    expect(picker.grid.textContent).toBe(
      "The image could not be uploaded. Please try again.",
    );
  });

  test("replaces the failure note when a second upload is refused", async () => {
    installDom(ADMIN_TEMPLATES);
    const picker = parts();
    fetchStubHolder.stub = stubFetch(
      refusal('<div class="error" role="alert">First refusal</div>'),
      refusal('<div class="error" role="alert">Second refusal</div>'),
    );
    wireUploadForm(picker, () => undefined);

    await submit(picker);
    await submit(picker);

    expect(
      picker.grid.querySelectorAll('[data-note="uploadFailed"]').length,
    ).toBe(1);
    expect(picker.grid.textContent).toBe("Second refusal");
  });

  test("sends the chosen file's bytes with its name", async () => {
    installDom(ADMIN_TEMPLATES);
    const picker = parts();
    const form = picker.form;
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
    wireUploadForm(picker, () => undefined);

    await submit(picker);

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
