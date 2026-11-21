import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initFormSubmitDisable } from "#src/ui/client/admin/form-submit-disable.ts";
import {
  createDomInstaller,
  createGlobalStash,
  fireEvent,
  requireElement,
} from "#test-utils/happy-dom.ts";

const dom = createDomInstaller();
const stash = createGlobalStash();
const FORM =
  '<form method="POST"><input name="name" value="Updated"><button type="submit">Save</button></form>';

const page = (html = FORM) => {
  const window = dom.installDom(html);
  const frames: FrameRequestCallback[] = [];
  stash.set("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  return {
    flush: () => {
      for (const callback of frames.splice(0)) callback(0);
    },
    window,
  };
};

const controls = (): { name: boolean; save: boolean } => ({
  name: requireElement<HTMLInputElement>(document, "input").disabled,
  save: requireElement<HTMLButtonElement>(document, "button").disabled,
});

describe("form submit protection", () => {
  afterEach(async () => {
    await dom.cleanup();
    stash.restore();
  });

  for (const added of ["before", "after"] as const) {
    test(`locks a form added ${added} initialisation after its native submit`, () => {
      const { flush, window } = page(added === "before" ? FORM : "");
      initFormSubmitDisable();
      if (added === "after") document.body.innerHTML = FORM;
      const form = requireElement<HTMLFormElement>(document, "form");
      const submit = new window.Event("submit", {
        bubbles: true,
        cancelable: true,
      });
      fireEvent(form, submit);

      expect(submit.defaultPrevented).toBe(false);
      expect(controls()).toEqual({ name: false, save: false });
      flush();
      expect(controls()).toEqual({ name: true, save: true });
      expect(requireElement<HTMLInputElement>(document, "input").value).toBe(
        "Updated",
      );
    });
  }

  for (const html of [
    '<form method="GET"><input><button type="submit">Search</button></form>',
    '<form method="POST" data-manual-checkin><input><button type="submit">Check in</button></form>',
  ]) {
    test(`leaves the form's own behaviour intact for ${html}`, () => {
      const { flush, window } = page(html);
      initFormSubmitDisable();
      const submit = new window.Event("submit", {
        bubbles: true,
        cancelable: true,
      });
      fireEvent(requireElement(document, "form"), submit);
      flush();
      expect(submit.defaultPrevented).toBe(false);
      expect(controls()).toEqual({ name: false, save: false });
    });
  }

  for (const cancelledAt of ["form", "document"] as const) {
    test(`keeps controls usable when the submit is cancelled at the ${cancelledAt}`, () => {
      const { flush, window } = page();
      initFormSubmitDisable();
      const form = requireElement<HTMLFormElement>(document, "form");
      const target = cancelledAt === "form" ? form : document;
      target.addEventListener("submit", (event) => event.preventDefault());
      const submit = new window.Event("submit", {
        bubbles: true,
        cancelable: true,
      });
      fireEvent(form, submit);
      flush();
      expect(submit.defaultPrevented).toBe(true);
      expect(controls()).toEqual({ name: false, save: false });
    });
  }

  test("leaves controls usable when a non-form emits a submit event", () => {
    const { flush, window } = page();
    initFormSubmitDisable();
    const submit = new window.Event("submit", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(document, submit);
    flush();
    expect(submit.defaultPrevented).toBe(false);
    expect(controls()).toEqual({ name: false, save: false });
  });

  test("unlocks POST controls only after a back or forward restore", () => {
    const { flush, window } = page(
      `${FORM}<form method="GET"><input disabled></form>`,
    );
    initFormSubmitDisable();
    fireEvent(
      requireElement(document, "form"),
      new window.Event("submit", { bubbles: true }),
    );
    flush();
    fireEvent(
      window,
      Object.assign(new window.Event("pageshow"), { persisted: false }),
    );
    expect(controls()).toEqual({ name: true, save: true });
    fireEvent(
      window,
      Object.assign(new window.Event("pageshow"), { persisted: true }),
    );
    expect(controls()).toEqual({ name: false, save: false });
    expect(
      requireElement<HTMLInputElement>(document, 'form[method="GET"] input')
        .disabled,
    ).toBe(true);
  });
});
