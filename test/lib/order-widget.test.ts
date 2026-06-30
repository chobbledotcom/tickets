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
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { Window } from "happy-dom";
import { orderWidgetBody } from "#routes/assets.ts";
import {
  buildCatalog,
  type CatalogSourceListing,
  serializeCatalog,
} from "#shared/external-order.ts";
import { testListing } from "#test-utils/factories.ts";

const ORIGIN = "https://tickets.test";
const MODULE_MARKER = "__orderWidgetModule";

/** The built bundle with its lone ESM export rewritten to a global assignment,
 * so the otherwise module-only body runs under `new Function`. */
const runnableBody = orderWidgetBody().replace(
  /export\s*\{\s*(\w+)\s+as\s+isExternalOrderModule\s*\}\s*;?\s*$/,
  `;globalThis.${MODULE_MARKER}=$1;`,
);

const makeCatalog = (listings: CatalogSourceListing[], debug: boolean) =>
  buildCatalog({
    currency: "GBP",
    debug,
    decimalPlaces: 2,
    generatedAt: "2026-06-30T00:00:00Z",
    listings,
    origin: ORIGIN,
  });

interface AnimateCall {
  keyframes: unknown;
  options: unknown;
}

/** Per-test DOM + widget harness. Installs a fresh happy-dom into the globals
 * the bundle reads, captures `console.debug`, navigation, animations, and focus,
 * and runs the widget script. */
const harness = () => {
  const window = new Window({ url: `${ORIGIN}/` });
  const document = window.document;
  const logs: unknown[][] = [];
  const navigations: string[] = [];
  const animateCalls: AnimateCall[] = [];
  const focusCalls: number[] = [];

  // happy-dom has no Web Animations API; the widget's cart "bump" only needs the
  // call to happen, so record it and return a benign stub.
  (
    window.HTMLElement.prototype as unknown as {
      animate: (keyframes: unknown, options: unknown) => unknown;
    }
  ).animate = (keyframes: unknown, options: unknown) => {
    animateCalls.push({ keyframes, options });
    return {};
  };
  const realFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function focusSpy(this: unknown) {
    focusCalls.push(1);
    return realFocus?.call(this);
  };

  const saved = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (key: string, value: unknown): void => {
    if (!saved.has(key)) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  };

  setGlobal("document", document);
  setGlobal("sessionStorage", window.sessionStorage);
  setGlobal("MutationObserver", window.MutationObserver);
  setGlobal("location", { assign: (url: string) => navigations.push(url) });

  const origDebug = console.debug;
  console.debug = (...args: unknown[]): void => {
    logs.push(args);
  };

  const restore = (): void => {
    console.debug = origDebug;
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    delete (globalThis as Record<string, unknown>).__chobbleExternalOrder;
    delete (globalThis as Record<string, unknown>)[MODULE_MARKER];
  };

  const setReadyState = (value: string): void => {
    Object.defineProperty(document, "readyState", {
      configurable: true,
      get: () => value,
    });
  };

  const run = (catalog: ReturnType<typeof makeCatalog>): void => {
    new Function(`${serializeCatalog(catalog)}\n${runnableBody}`)();
  };

  // happy-dom delivers MutationObserver records via its async task manager;
  // wait for those tasks to settle (and clear their timers) before asserting.
  const flush = (): Promise<void> => window.happyDOM.waitUntilComplete();

  const cleanup = async (): Promise<void> => {
    await window.happyDOM.abort();
    window.close();
  };

  return {
    animateCalls,
    cleanup,
    document,
    flush,
    focusCalls,
    logs,
    navigations,
    restore,
    run,
    setGlobal,
    setReadyState,
    window,
  };
};

type Harness = ReturnType<typeof harness>;

const listing = (
  overrides: Partial<CatalogSourceListing> & { id: number; slug: string },
): CatalogSourceListing => testListing(overrides);

const setBody = (h: Harness, html: string): void => {
  h.document.body.innerHTML = html;
};

const addLink = (slug: string, quantity?: string): string =>
  `<a data-add-listing="${ORIGIN}/ticket/${slug}"${
    quantity === undefined ? "" : ` data-add-quantity="${quantity}"`
  }>Book ${slug}</a>`;

// Minimal structural views of the happy-dom nodes the tests touch, so the file
// needs neither the DOM lib (which would clash with happy-dom's own types) nor
// `any`.
interface Queryable {
  querySelector(selector: string): QueryNode | null;
  querySelectorAll(selector: string): ArrayLike<QueryNode>;
}
interface QueryNode extends Queryable {
  textContent: string;
  hidden: boolean;
  open: boolean;
  type: string;
  getAttribute(name: string): string | null;
  dispatchEvent(event: unknown): boolean;
  click(): void;
}

const hostEl = (h: Harness) => h.document.querySelector("[data-chobble-order]");

const shadow = (h: Harness): Queryable => {
  const host = hostEl(h);
  if (!host) throw new Error("widget host not mounted");
  return (host as unknown as { shadowRoot: Queryable }).shadowRoot;
};

const cartButton = (h: Harness): QueryNode =>
  shadow(h).querySelector(".cart-button") as QueryNode;

const dialogEl = (h: Harness): QueryNode =>
  shadow(h).querySelector("dialog") as QueryNode;

const clickAnchor = (h: Harness, slug: string): boolean => {
  const anchor = h.document.querySelector(
    `a[data-add-listing="${ORIGIN}/ticket/${slug}"]`,
  ) as unknown as QueryNode;
  const event = new h.window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  anchor.dispatchEvent(event);
  return (event as unknown as { defaultPrevented: boolean }).defaultPrevented;
};

const clickIn = (root: Queryable, selector: string): void => {
  (root.querySelector(selector) as QueryNode).click();
};

const openCart = (h: Harness): QueryNode => {
  cartButton(h).click();
  return dialogEl(h);
};

const logHas = (h: Harness, first: string): boolean =>
  h.logs.some((entry) => entry[1] === first);

/** The `type` property of a button matched in the shadow root. */
const buttonType = (root: Queryable, selector: string): string =>
  (root.querySelector(selector) as QueryNode).type;

const textOf = (root: Queryable, selector: string): string | undefined =>
  (root.querySelector(selector) as QueryNode | null)?.textContent;

const storedCart = (h: Harness): unknown => {
  const raw = h.window.sessionStorage.getItem(
    `tickets:external-order:v1:${ORIGIN}`,
  );
  return raw === null ? null : JSON.parse(raw);
};

/** Mount the widget with a single enhanceable "open" listing in the page. */
const mountOpenListing = (h: Harness, debug = false): void => {
  setBody(h, addLink("open"));
  h.run(makeCatalog([listing({ id: 1, slug: "open" })], debug));
};

/** Mount, add one "open" ticket, and open the cart dialog. */
const openCartWithOne = (h: Harness): QueryNode => {
  mountOpenListing(h);
  clickAnchor(h, "open");
  return openCart(h);
};

const stepperButtons = (dialog: Queryable): QueryNode[] =>
  Array.from(dialog.querySelectorAll(".stepper button")) as QueryNode[];

/** Install a stubbed `sessionStorage` and return the array its `setItem` records
 * (`failSet` makes every write throw after recording). */
const stubStorage = (
  h: Harness,
  handlers: {
    getItem: () => string | null;
    removeItem?: () => void;
    failSet?: boolean;
  },
): unknown[] => {
  const setCalls: unknown[] = [];
  h.setGlobal("sessionStorage", {
    getItem: handlers.getItem,
    removeItem: handlers.removeItem ?? (() => {}),
    setItem: (key: string, value: string) => {
      setCalls.push([key, value]);
      if (handlers.failSet) throw new Error("write failed");
    },
  });
  return setCalls;
};

// happy-dom's `Window` starts internal async tasks/timers (its task manager and
// MutationObserver delivery) that no public teardown — `abort()`, `close()`,
// `waitUntilComplete()` — fully clears, so Deno's op/resource sanitizers flag
// them as leaks under the coverage runner. They are confined to the emulated
// DOM and torn down in `afterEach`; disable the sanitizers for this suite only.
describe("order widget", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  afterEach(async () => {
    h.restore();
    await h.cleanup();
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

  test("the close button and the dialog close event return focus", () => {
    const dialog = openCartWithOne(h);
    expect(dialog.open).toBe(true);

    clickIn(dialog, ".close");
    expect(dialog.open).toBe(false);

    dialog.dispatchEvent(new h.window.Event("close"));
    expect(h.focusCalls.length).toBeGreaterThan(0);
  });

  test("drops stored items no longer in the catalog and notes it once", () => {
    h.window.sessionStorage.setItem(
      `tickets:external-order:v1:${ORIGIN}`,
      JSON.stringify([
        { quantity: 1, slug: "gone" },
        { quantity: 2, slug: "open" },
      ]),
    );
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], true));

    expect(logHas(h, "reconcile dropped unavailable cart items")).toBe(true);
    // The drop notice is rendered at construction (a subsequent re-render clears
    // it), so read it straight from the cart body rather than after re-opening.
    expect(
      (shadow(h).querySelector(".notice") as { textContent: string })
        .textContent,
    ).toBe("Some items are no longer available and were removed.");
    // The reconciled cart is re-saved without the dropped slug.
    expect(storedCart(h)).toEqual([{ quantity: 2, slug: "open" }]);
    // The notice is shown once: re-opening the cart re-renders without it.
    const dialog = openCart(h);
    expect(dialog.querySelector(".notice")).toBeNull();
  });

  test("merges duplicate stored lines for the same slug", () => {
    h.window.sessionStorage.setItem(
      `tickets:external-order:v1:${ORIGIN}`,
      JSON.stringify([
        { quantity: 1, slug: "open" },
        { quantity: 2, slug: "open" },
      ]),
    );
    h.run(makeCatalog([listing({ id: 7, slug: "open" })], false));

    expect(cartButton(h).querySelector(".count")!.textContent).toBe("3");
    const dialog = openCart(h);
    clickIn(dialog, ".continue");
    expect(h.navigations).toEqual([`${ORIGIN}/ticket/open?q_7=3`]);
  });

  test("keeps only well-formed stored cart lines", () => {
    h.window.sessionStorage.setItem(
      `tickets:external-order:v1:${ORIGIN}`,
      JSON.stringify([
        null,
        { quantity: 1, slug: "open" },
        { slug: "open" },
        { quantity: -1, slug: "open" },
        { quantity: 2.5, slug: "open" },
        { quantity: 1 },
      ]),
    );
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], false));

    expect(cartButton(h).querySelector(".count")!.textContent).toBe("1");
  });

  test("ignores a non-array stored value", () => {
    h.window.sessionStorage.setItem(
      `tickets:external-order:v1:${ORIGIN}`,
      JSON.stringify({ quantity: 1, slug: "open" }),
    );
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], false));

    expect(hostEl(h)).not.toBeNull();
    expect(shadow(h).querySelector(".cart-button")).not.toBeNull();
    expect(cartButton(h).hidden).toBe(true);
  });

  test("discards a corrupt stored cart but keeps using storage", () => {
    const key = `tickets:external-order:v1:${ORIGIN}`;
    h.window.sessionStorage.setItem(key, "{not json");
    const removeSpy = spy(h.window.sessionStorage, "removeItem");
    mountOpenListing(h, true);

    expect(logHas(h, "discarding corrupt stored cart")).toBe(true);
    // The corrupt entry is actively removed before storage is reused.
    expect(removeSpy.calls.map((c) => c.args[0])).toContain(key);
    // The corrupt value is dropped; the reconciled empty cart is re-saved over
    // it, proving storage is still in use (not memory-only).
    expect(JSON.parse(h.window.sessionStorage.getItem(key)!)).toEqual([]);

    clickAnchor(h, "open");
    expect(JSON.parse(h.window.sessionStorage.getItem(key)!)).toEqual([
      { quantity: 1, slug: "open" },
    ]);
  });

  test("falls back to memory-only when storage reads throw", () => {
    const setCalls = stubStorage(h, {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    mountOpenListing(h, true);

    expect(logHas(h, "sessionStorage unavailable; cart is memory-only")).toBe(
      true,
    );
    // memoryOnly suppresses every write; the cart still works in memory.
    clickAnchor(h, "open");
    expect(setCalls).toEqual([]);
    expect(cartButton(h).querySelector(".count")!.textContent).toBe("1");
  });

  test("goes memory-only when a corrupt cart cannot be cleared", () => {
    const setCalls = stubStorage(h, {
      getItem: () => "{not json",
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    mountOpenListing(h);

    clickAnchor(h, "open");
    expect(setCalls).toEqual([]);
    expect(cartButton(h).querySelector(".count")!.textContent).toBe("1");
  });

  test("stops retrying writes once a save fails", () => {
    const setCalls = stubStorage(h, { failSet: true, getItem: () => null });
    mountOpenListing(h);
    // The constructor's save attempt flips to memory-only; later adds must not
    // retry the failing write.
    const afterInit = setCalls.length;
    clickAnchor(h, "open");

    expect(setCalls.length).toBe(afterInit);
    expect(cartButton(h).querySelector(".count")!.textContent).toBe("1");
  });

  test("a second init for the same origin is a no-op", () => {
    setBody(h, addLink("open"));
    const catalog = makeCatalog([listing({ id: 1, slug: "open" })], true);
    h.run(catalog);
    h.run(catalog);

    expect(h.document.querySelectorAll("[data-chobble-order]")).toHaveLength(1);
    expect(logHas(h, "already initialised for")).toBe(true);
  });

  test("runs init immediately when the document is already parsed", () => {
    h.setReadyState("complete");
    setBody(h, addLink("open"));
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], false));

    expect(hostEl(h)).not.toBeNull();
  });

  test("defers init to DOMContentLoaded while the document is loading", () => {
    h.setReadyState("loading");
    setBody(h, addLink("open"));
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], false));

    expect(hostEl(h)).toBeNull();
    h.document.dispatchEvent(new h.window.Event("DOMContentLoaded"));
    expect(hostEl(h)).not.toBeNull();
  });

  test("enhances direct and nested links added after load", async () => {
    setBody(h, "<section></section>");
    h.run(makeCatalog([listing({ id: 1, slug: "late" })], false));

    h.document.body.insertAdjacentHTML("beforeend", addLink("late"));
    h.document
      .querySelector("section")!
      .insertAdjacentHTML("beforeend", addLink("late"));
    await h.flush();

    const enhanced = Array.from(
      h.document.querySelectorAll("a[data-chobble-enhanced]"),
    );
    expect(enhanced).toHaveLength(2);
  });

  test("observes deep subtree insertions, not just body's children", async () => {
    setBody(h, "<div><p></p></div>");
    h.run(makeCatalog([listing({ id: 1, slug: "deep" })], false));

    // Mutate only a deeply nested node — no direct child of <body> changes — so
    // the observer must be watching the subtree, not just body's children.
    h.document
      .querySelector("p")!
      .insertAdjacentHTML("beforeend", addLink("deep"));
    await h.flush();

    expect(h.document.querySelector("a[data-chobble-enhanced]")).not.toBeNull();
  });

  test("re-resolves at click time and ignores a now-foreign link", () => {
    setBody(h, addLink("open"));
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], false));
    const anchor = h.document.querySelector("a")!;
    anchor.setAttribute("data-add-listing", `${ORIGIN}/ticket/unknown`);

    const prevented = clickAnchor(h, "unknown");
    expect(prevented).toBe(false);
    expect(cartButton(h).hidden).toBe(true);
  });

  test("keeps module-only syntax via the exported marker", () => {
    setBody(h, "");
    h.run(makeCatalog([], false));
    const marker = (globalThis as Record<string, unknown>)[MODULE_MARKER] as
      | (() => boolean)
      | undefined;
    expect(marker?.()).toBe(true);
  });
});
