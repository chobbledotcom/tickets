/**
 * The checkout popup: what it opens, what it waits for, and where it sends
 * the iframe after a payment. The words come from the server page; these
 * tests pin the navigation and the waiting state.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import type { Window } from "happy-dom";
import { initCheckoutPopup } from "#src/ui/client/admin/checkout-popup.ts";
import {
  createDomInstaller,
  createGlobalStash,
} from "#test-utils/happy-dom.ts";

const ORIGIN = "https://admin.test";

/** The popup page as the server renders it, with the confirmation URL the
 *  client must navigate the iframe to. */
const POPUP_HTML = `
  <div
    data-checkout-popup="https://checkout.stripe.com/session123"
    data-success-href="/ticket/reserved?iframe=true"
  >
    <p>
      <a
        class="btn"
        data-open-checkout
        href="https://checkout.stripe.com/session123"
        target="_blank"
      >Pay Now</a>
    </p>
    <div data-checkout-waiting hidden>
      <p>Waiting</p>
    </div>
  </div>`;

/** The parts of the popup page these tests drive. */
type PopupElement = {
  click: () => void;
  hidden: boolean;
  parentElement: PopupElement;
};

/** Stub `window.open` to hand back `popup`, press the Pay Now link, and hand
 *  back the Pay row and the waiting box. */
const pressPay = (
  window: Window,
  popup: { closed: boolean },
): { pay: PopupElement; waiting: PopupElement } => {
  window.open = (() => popup) as typeof window.open;
  const anchor = window.document.querySelector(
    "[data-open-checkout]",
  ) as unknown as PopupElement;
  const waiting = window.document.querySelector(
    "[data-checkout-waiting]",
  ) as unknown as PopupElement;
  anchor.click();
  return { pay: anchor.parentElement, waiting };
};

describe("the checkout popup", () => {
  const stash = createGlobalStash();
  const dom = createDomInstaller();

  afterEach(async () => {
    stash.restore();
    await dom.cleanup();
  });

  /** Install the popup page, record where `location.href` lands, and boot
   *  the script. */
  const openPopup = (): { navigations: string[]; window: Window } => {
    const navigations: string[] = [];
    const window = dom.installDom(POPUP_HTML);
    stash.set("location", {
      get href(): string {
        return navigations.at(-1) ?? "";
      },
      set href(url: string) {
        navigations.push(url);
      },
      origin: ORIGIN,
    });
    initCheckoutPopup();
    return { navigations, window };
  };

  const messageFrom = (window: Window, type: string, origin = ORIGIN) =>
    new window.MessageEvent("message", { data: { type }, origin });

  test("does nothing on a page without a popup", () => {
    dom.installDom("<p>No checkout here</p>");
    expect(() => initCheckoutPopup()).not.toThrow();
  });

  test("navigates the iframe to the rendered confirmation URL on payment-success", () => {
    const { navigations, window } = openPopup();
    window.dispatchEvent(messageFrom(window, "payment-success"));
    expect(navigations).toEqual(["/ticket/reserved?iframe=true"]);
  });

  test("ignores a payment-success message from another origin", () => {
    const { navigations, window } = openPopup();
    window.dispatchEvent(
      messageFrom(window, "payment-success", "https://evil.test"),
    );
    expect(navigations).toEqual([]);
  });

  test("leaves the page alone on an unknown message type", () => {
    const { navigations, window } = openPopup();
    window.dispatchEvent(messageFrom(window, "payment-unknown"));
    expect(navigations).toEqual([]);
  });

  test("shows the Pay button again on payment-cancel", () => {
    // FakeTime holds the watcher's poll timer, so none survives the test.
    using _time = new FakeTime();
    const { window } = openPopup();
    const { pay, waiting } = pressPay(window, { closed: false });
    expect(waiting.hidden).toBe(false);

    window.dispatchEvent(messageFrom(window, "payment-cancel"));
    expect(waiting.hidden).toBe(true);
    expect(pay.hidden).toBe(false);
  });

  test("keeps waiting while the checkout window stays open", () => {
    using time = new FakeTime();
    const { window } = openPopup();
    const { waiting } = pressPay(window, { closed: false });

    time.tick(1500);
    expect(waiting.hidden).toBe(false);
  });

  test("puts the Pay button back when the window closes without paying", () => {
    using time = new FakeTime();
    const { window } = openPopup();
    const popup = { closed: false };
    const { pay, waiting } = pressPay(window, popup);
    expect(waiting.hidden).toBe(false);

    popup.closed = true;
    time.tick(500);
    expect(waiting.hidden).toBe(true);
    expect(pay.hidden).toBe(false);
  });
});
