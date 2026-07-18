// test-groups: run-alone

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  addLink,
  cartButton,
  clickAnchor,
  clickIn,
  hostEl,
  listing,
  logHas,
  MODULE_MARKER,
  makeCatalog,
  mountOpenListing,
  ORIGIN,
  openCart,
  setBody,
  shadow,
  storedCart,
  stubStorage,
  useOrderHarness,
} from "./support.ts";

describe("order widget storage and lifecycle", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const h = useOrderHarness();

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
    expect(
      (shadow(h).querySelector(".notice") as { textContent: string })
        .textContent,
    ).toBe("Some items are no longer available and were removed.");
    expect(storedCart(h)).toEqual([{ quantity: 2, slug: "open" }]);
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
    expect(removeSpy.calls.map((c) => c.args[0])).toContain(key);
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
      removeItem: () => {},
    });
    mountOpenListing(h, true);

    expect(logHas(h, "sessionStorage unavailable; cart is memory-only")).toBe(
      true,
    );
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
    const setCalls = stubStorage(h, {
      failSet: true,
      getItem: () => null,
      removeItem: () => {},
    });
    mountOpenListing(h);
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

    expect(
      Array.from(h.document.querySelectorAll("a[data-chobble-enhanced]")),
    ).toHaveLength(2);
  });

  test("observes deep subtree insertions, not just body's children", async () => {
    setBody(h, "<div><p></p></div>");
    h.run(makeCatalog([listing({ id: 1, slug: "deep" })], false));

    h.document
      .querySelector("p")!
      .insertAdjacentHTML("beforeend", addLink("deep"));
    await h.flush();

    expect(h.document.querySelector("a[data-chobble-enhanced]")).not.toBeNull();
  });

  test("re-resolves at click time and ignores a now-foreign link", () => {
    setBody(h, addLink("open"));
    h.run(makeCatalog([listing({ id: 1, slug: "open" })], false));
    h.document
      .querySelector("a")!
      .setAttribute("data-add-listing", `${ORIGIN}/ticket/unknown`);

    expect(clickAnchor(h, "unknown")).toBe(false);
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
