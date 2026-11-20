import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { initImageLibrary } from "#src/ui/client/admin/image-library.ts";
import { AdminModalTemplate } from "#templates/admin/modal.tsx";
import {
  closeDialogs,
  createDomInstaller,
  createGlobalStash,
  fireEvent,
  requireElement,
  requireElements,
} from "#test-utils/happy-dom.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

const TEMPLATE = await withRequestContext(() => String(AdminModalTemplate()));
const dom = createDomInstaller();
const stash = createGlobalStash();
const GRID_HTML = `
  <ul data-image-library data-modal-loading="Loading…">
    <li><a data-image-edit-id="7" data-image-edit-name="Hero"
           href="/admin/images/7/edit">Hero</a></li>
    <li><a data-image-edit-id="8" data-image-edit-name="Poster"
           href="/admin/images/8/edit">Poster</a></li>
  </ul>`;
const FORM_HTML =
  '<form action="/admin/images/7/edit"><input name="name" value="Hero"></form>';
type Answer = { ok?: boolean; redirected?: boolean; reject?: boolean };

const harness = (html = GRID_HTML, answer: Answer = {}) => {
  const window = dom.installDom(TEMPLATE + html);
  const assigned: string[] = [];
  const requests: string[] = [];
  window.location.assign = (url: string): void => {
    assigned.push(url);
  };
  stash.set("fetch", (input: unknown): Promise<unknown> => {
    requests.push(String(input));
    if (answer.reject === true)
      return Promise.reject(new Error("The network is down"));
    return Promise.resolve({
      ok: answer.ok ?? true,
      redirected: answer.redirected ?? false,
      text: () => Promise.resolve(FORM_HTML),
    });
  });
  initImageLibrary();
  return { assigned, document: window.document, requests, window };
};

const plainClick = (
  window: Window,
  shape: ConstructorParameters<Window["MouseEvent"]>[1] = {},
) =>
  new window.MouseEvent("click", {
    bubbles: true,
    button: 0,
    cancelable: true,
    detail: 1,
    ...shape,
  });

const clickImage = (window: Window, id = "7"): void => {
  fireEvent(
    requireElement(window.document, `a[data-image-edit-id='${id}']`),
    plainClick(window),
  );
};

// The loader only queues microtasks. Drain them before the DOM assertions.
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

const closeModals = (): void => closeDialogs(document, "dialog.admin-modal");

describe("initImageLibrary", () => {
  afterEach(async () => {
    closeModals();
    await dom.cleanup();
    stash.restore();
  });

  test("opens the edit form in the shared modal on a plain click", async () => {
    const { assigned, document, requests, window } = harness();
    const link = requireElement(document, "a[data-image-edit-id='7']");
    const event = plainClick(window);
    fireEvent(link, event);

    expect(event.defaultPrevented).toBe(true);
    expect(requests).toEqual(["/admin/images/7/edit?modal=1"]);
    expect(requireElement(document, ".admin-modal-title").textContent).toBe(
      "Hero",
    );
    expect(requireElement(document, ".admin-modal-body").textContent).toBe(
      "Loading…",
    );
    await settle();
    expect(
      requireElement(document, ".admin-modal-body form").getAttribute("action"),
    ).toBe("/admin/images/7/edit");
    expect(assigned).toEqual([]);
  });

  test("leaves modified, middle-button, and keyboard clicks to the browser", () => {
    const { document, requests, window } = harness();
    const link = requireElement(document, "a[data-image-edit-id='7']");
    for (const shape of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { button: 1 },
      { detail: 0 },
    ]) {
      const event = plainClick(window, shape);
      fireEvent(link, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(document.querySelector(".admin-modal")).toBe(null);
    expect(requests).toEqual([]);
  });

  test("raises an existing image window without discarding its edits or refetching", async () => {
    const { document, requests, window } = harness();
    clickImage(window);
    await settle();
    const field = requireElement<HTMLInputElement>(
      document,
      ".admin-modal-body input",
    );
    field.value = "Unsaved name";
    clickImage(window, "8");
    clickImage(window);
    await settle();

    expect(requests).toEqual([
      "/admin/images/7/edit?modal=1",
      "/admin/images/8/edit?modal=1",
    ]);
    expect(field.value).toBe("Unsaved name");
    expect(
      requireElement(document, '[data-modal-key="image-edit:7"] input'),
    ).toBe(field);
    expect(
      requireElements<HTMLDialogElement>(document, "dialog.admin-modal").map(
        (dialog) => dialog.style.zIndex,
      ),
    ).toEqual(["1001", "1000"]);
  });

  test("does not start another request while the image form loads", async () => {
    const { requests, window } = harness();
    clickImage(window);
    clickImage(window);
    await settle();
    expect(requests).toEqual(["/admin/images/7/edit?modal=1"]);
  });

  test("uses a new form after the window closes", async () => {
    const { document, requests, window } = harness();
    clickImage(window);
    await settle();
    requireElement<HTMLDialogElement>(document, "dialog.admin-modal").close();
    clickImage(window);
    await settle();
    expect(requests).toEqual([
      "/admin/images/7/edit?modal=1",
      "/admin/images/7/edit?modal=1",
    ]);
    expect(
      requireElement<HTMLInputElement>(document, ".admin-modal-body input")
        .value,
    ).toBe("Hero");
  });

  for (const answer of [
    { ok: false },
    { reject: true },
    { redirected: true },
  ]) {
    test(`falls back to the full edit page after ${JSON.stringify(answer)}`, async () => {
      const { assigned, window } = harness(GRID_HTML, answer);
      clickImage(window);
      await settle();
      expect(assigned).toEqual(["/admin/images/7/edit"]);
    });
  }

  test("does not navigate after a dismissed window's request fails", async () => {
    const { assigned, document, window } = harness();
    const pending = Promise.withResolvers<Response>();
    stash.set("fetch", () => pending.promise);
    clickImage(window);
    requireElement<HTMLDialogElement>(document, "dialog.admin-modal").close();
    pending.reject(new Error("The network is down"));
    await settle();
    expect(assigned).toEqual([]);
    expect(document.querySelector("dialog.admin-modal")).toBe(null);
  });

  test("does nothing on a page without the image grid", () => {
    const { document } = harness("<p>No library here.</p>");
    expect(document.querySelector(".admin-modal")).toBe(null);
  });

  test("fails loudly when the grid carries no load label", () => {
    dom.installDom("<ul data-image-library></ul>");
    expect(() => initImageLibrary()).toThrow(
      "Missing data attribute: modalLoading",
    );
  });
});
