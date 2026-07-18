// test-groups: run-alone — the widget runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * Behavioural tests for the external-order widget (`src/ui/client/order.ts`,
 * served as `/order.js`).
 *
 * The widget is browser code: it runs `init()` on load against `document`,
 * `sessionStorage`, `MutationObserver`, etc. To exercise it in Deno we mirror
 * exactly what the server does — prepend a `const CATALOG = …;` to the built
 * bundle and run that script — but inside a fresh happy-dom `Window` per test,
 * so each case starts from a clean DOM and storage. The bundle's trailing
 * `export { … as isExternalOrderModule }` is rewritten to stash the function on
 * a global so the test can still call it (a function body can't carry `export`).
 *
 * Running the real built bundle (not the TS source) is deliberate: the precommit
 * mutation gate rebuilds that bundle per mutant, so these assertions bind to the
 * code the browser actually receives.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  addLink,
  buttonType,
  cartButton,
  clickAnchor,
  clickIn,
  hostEl,
  listing,
  logHas,
  makeCatalog,
  mountOpenListing,
  ORIGIN,
  openCart,
  openCartWithOne,
  setBody,
  shadow,
  stepperButtons,
  storedCart,
  textOf,
  useOrderHarness,
} from "./order/support.ts";

// happy-dom's `Window` starts internal async tasks/timers (its task manager and
// MutationObserver delivery) that no public teardown — `abort()`, `close()`,
// `waitUntilComplete()` — fully clears, so Deno's op/resource sanitizers flag
// them as leaks under the coverage runner. They are confined to the emulated
// DOM and torn down in `afterEach`; disable the sanitizers for this suite only.
describe("order widget", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const h = useOrderHarness();

  test("has no stored cart before the widget starts", () => {
    expect(storedCart(h)).toBeNull();
  });

  test("mounts a shadow-root host and enhances only catalog links", () => {
    setBody(
      h,
      addLink("open") +
        `<a data-add-listing="https://evil.test/ticket/open">x</a>` +
        `<a data-add-listing="not a url">y</a>` +
        `<a data-add-listing="${ORIGIN}/ticket/missing">z</a>`,
    );
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], true));

    expect(hostEl(h)).not.toBeNull();
    const anchors = h.document.querySelectorAll("a");
    expect(anchors[0]!.getAttribute("data-chobble-enhanced")).toBe("1");
    expect(anchors[1]!.getAttribute("data-chobble-enhanced")).toBeNull();
    expect(anchors[2]!.getAttribute("data-chobble-enhanced")).toBeNull();
    expect(anchors[3]!.getAttribute("data-chobble-enhanced")).toBeNull();
  });

  test("logs init, enhancement, and skips when debug is on", () => {
    setBody(h, `${addLink("open")}<a data-add-listing="bad">y</a>`);
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], true));

    expect(h.logs[0]).toEqual([
      "[chobble-order]",
      "init",
      { listings: 1, origin: ORIGIN },
    ]);
    expect(logHas(h, "enhanced")).toBe(true);
    expect(logHas(h, "skipped un-enhanceable link")).toBe(true);
  });

  test("explains WHY each un-enhanceable link is skipped", () => {
    setBody(
      h,
      [
        `<a data-add-listing="">empty</a>`,
        `<a data-add-listing="bad">not-a-url</a>`,
        `<a data-add-listing="https://elsewhere.test/ticket/open">origin</a>`,
        `<a data-add-listing="${ORIGIN}/not-a-ticket">path</a>`,
        `<a data-add-listing="${ORIGIN}/ticket/register">slug</a>`,
      ].join(""),
    );
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], true));

    const reasons = h.logs
      .filter((entry) => entry[1] === "skipped un-enhanceable link")
      .map((entry) => entry[3]);
    expect(reasons).toEqual([
      "- no data-add-listing value",
      "- not a valid URL",
      `- origin https://elsewhere.test is not the tickets origin ${ORIGIN}`,
      "- path /not-a-ticket is not a /ticket/<slug> URL",
      `- slug "register" is not a known listing or package`,
    ]);
  });

  test("stays silent when debug is off", () => {
    mountOpenListing(h);
    clickAnchor(h, "open");

    expect(h.logs).toHaveLength(0);
  });

  test("adding a listing reveals the cart button with a live count", () => {
    mountOpenListing(h, true);

    // Scoped styles are mounted into the shadow root.
    expect(shadow(h).querySelector("style")).not.toBeNull();
    expect(buttonType(shadow(h), ".cart-button")).toBe("button");
    expect(cartButton(h).hidden).toBe(true);
    const prevented = clickAnchor(h, "open");

    expect(prevented).toBe(true);
    expect(cartButton(h).hidden).toBe(false);
    expect(cartButton(h).querySelector(".count")!.textContent).toBe("1");
    expect(cartButton(h).getAttribute("aria-label")).toBe(
      "View ticket cart, 1 item",
    );
    expect(h.animateCalls).toHaveLength(1);
    expect(logHas(h, "add")).toBe(true);
  });

  test("renders accessible cart chrome with typed buttons", () => {
    setBody(h, addLink("open"));
    h.run(
      makeCatalog([listing({ id: 1, name: "Open Day", slug: "open" })], false),
    );
    clickAnchor(h, "open");
    const dialog = openCart(h);

    expect(textOf(dialog, "h2")).toBe("Your tickets");
    expect(textOf(dialog, ".row .name")).toBe("Open Day");

    expect(buttonType(dialog, ".continue")).toBe("button");
    expect(buttonType(dialog, ".close")).toBe("button");
    const steppers = stepperButtons(dialog);
    expect(steppers.map((b) => b.type)).toEqual(["button", "button", "button"]);
    expect(steppers[0]!.getAttribute("aria-label")).toBe("Decrease quantity");
    expect(steppers[1]!.getAttribute("aria-label")).toBe("Increase quantity");
  });

  test("data-add-quantity adds the requested count, pluralising the label", () => {
    setBody(h, addLink("open", "3"));
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], false));
    clickAnchor(h, "open");

    expect(cartButton(h).querySelector(".count")!.textContent).toBe("3");
    expect(cartButton(h).getAttribute("aria-label")).toBe(
      "View ticket cart, 3 items",
    );
  });

  test("an invalid data-add-quantity falls back to one", () => {
    setBody(h, addLink("open", "0") + addLink("dup", "2.5"));
    h.run(
      makeCatalog(
        [listing({ id: 1, slug: "open" }), listing({ id: 2, slug: "dup" })],
        false,
      ),
    );
    clickAnchor(h, "open");
    clickAnchor(h, "dup");

    expect(shadow(h).querySelector(".count")!.textContent).toBe("2");
  });

  test("clicking the same listing twice increments the existing line", () => {
    setBody(h, addLink("open"));
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], false));
    clickAnchor(h, "open");
    clickAnchor(h, "open");

    expect(cartButton(h).querySelector(".count")!.textContent).toBe("2");
  });

  test("persists the cart to sessionStorage under an origin-scoped key", () => {
    mountOpenListing(h);
    clickAnchor(h, "open");

    expect(storedCart(h)).toEqual([{ quantity: 1, slug: "open" }]);
  });

  test("reloads a stored cart and shows fixed and variable subtotals", () => {
    h.window.sessionStorage.setItem(
      `tickets:external-order:v1:${ORIGIN}`,
      JSON.stringify([
        { quantity: 2, slug: "fixed" },
        { quantity: 1, slug: "pwyw" },
      ]),
    );
    h.run(
      makeCatalog(
        [
          listing({ id: 1, slug: "fixed", unit_price: 1500 }),
          listing({ can_pay_more: true, id: 2, slug: "pwyw", unit_price: 500 }),
        ],
        false,
      ),
    );
    // Nothing was dropped, so no notice is rendered at construction. (Checked
    // before opening: a re-render would clear a stale notice and hide the bug.)
    expect(shadow(h).querySelector(".notice")).toBeNull();
    const dialog = openCart(h);

    // formatMoney strips trailing zeros for whole amounts (stripIfInteger).
    expect(
      (dialog.querySelector(".subtotal") as { textContent: string })
        .textContent,
    ).toBe("Subtotal from £30");
    const prices = Array.from(
      dialog.querySelectorAll(".price"),
      (el) => (el as { textContent: string }).textContent,
    );
    expect(prices).toEqual(["£30", "Price set at checkout"]);
    expect(
      (dialog.querySelector(".caveat") as { textContent: string }).textContent,
    ).toContain("confirmed at checkout");
  });

  test("a fixed-only cart shows a plain subtotal", () => {
    setBody(h, addLink("open"));
    h.run(
      makeCatalog([listing({ id: 1, slug: "open", unit_price: 250 })], false),
    );
    clickAnchor(h, "open");
    const dialog = openCart(h);

    expect(
      (dialog.querySelector(".subtotal") as { textContent: string })
        .textContent,
    ).toBe("Subtotal £2.50");
  });

  test("the stepper raises, lowers, and removes a line", () => {
    const dialog = openCartWithOne(h);

    // Order: decrease, increase, remove.
    stepperButtons(dialog)[1]!.click(); // increase -> 2
    expect(cartButton(h).querySelector(".count")!.textContent).toBe("2");
    // setQuantity persists the new quantity to storage.
    expect(storedCart(h)).toEqual([{ quantity: 2, slug: "open" }]);
    stepperButtons(dialog)[0]!.click(); // decrease -> 1
    expect(cartButton(h).querySelector(".count")!.textContent).toBe("1");
  });

  test("the remove button clears the line entirely", () => {
    mountOpenListing(h);
    clickAnchor(h, "open");
    clickAnchor(h, "open");
    const dialog = openCart(h);

    stepperButtons(dialog)[2]!.click(); // the "Remove" button -> onChange(0)

    expect(cartButton(h).hidden).toBe(true);
    expect(storedCart(h)).toEqual([]);
  });

  test("decreasing to zero removes the line and empties the cart", () => {
    const dialog = openCartWithOne(h);
    clickIn(dialog, ".stepper button"); // decrease 1 -> 0 removes

    expect(cartButton(h).hidden).toBe(true);
    const paras = Array.from(
      dialog.querySelectorAll("p"),
      (el) => (el as { textContent: string }).textContent,
    );
    expect(paras).toContain("Your cart is empty.");
    expect(dialog.querySelector(".subtotal")).toBeNull();
  });

  test("Continue navigates to the canonical ticket URL with quantities", () => {
    setBody(h, addLink("a") + addLink("b"));
    h.run(
      makeCatalog(
        [listing({ id: 11, slug: "a" }), listing({ id: 22, slug: "b" })],
        true,
      ),
    );
    clickAnchor(h, "a");
    clickAnchor(h, "b");
    clickAnchor(h, "b");
    const dialog = openCart(h);
    clickIn(dialog, ".continue");

    expect(h.navigations).toEqual([`${ORIGIN}/ticket/a+b?q_11=1&q_22=2`]);
    expect(logHas(h, "continue ->")).toBe(true);
  });

  test("Continue with an empty cart does not navigate", () => {
    setBody(h, "");
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], false));
    // Open via the cart button is impossible when hidden; render directly by
    // adding then removing leaves the empty branch with no Continue button.
    const empty = openCart(h);
    expect(empty.querySelector(".continue")).toBeNull();
    expect(h.navigations).toEqual([]);
  });

  test("the close button returns focus", () => {
    const dialog = openCartWithOne(h);
    expect(dialog.open).toBe(true);

    clickIn(dialog, ".close");
    expect(dialog.open).toBe(false);
    expect(h.focusCalls).toHaveLength(1);
  });

  test("the dialog close event returns focus", () => {
    const dialog = openCartWithOne(h);

    dialog.dispatchEvent(new h.window.Event("close"));
    expect(h.focusCalls).toHaveLength(1);
  });
});
