import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  addLink,
  cartButton,
  clickAnchor,
  hostElOrNull,
  listing,
  makeCatalog,
  ORIGIN,
  type QueryNode,
  setBody,
  shadow,
  useOrderHarness,
} from "./support.ts";

// happy-dom's internal timers need the sanitizers off (see order.test.ts).
describe("order widget structure", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const h = useOrderHarness();

  const singleCatalog = (): ReturnType<typeof makeCatalog> =>
    makeCatalog([listing({ id: 1, slug: "open" })], false);

  /** The one element a selector must name inside the shadow root. */
  const one = (root: QueryNode, selector: string): QueryNode => {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`The cart dialog carries no ${selector}`);
    return el;
  };

  const hostTag = (): string => {
    const host = hostElOrNull(h);
    if (!host) throw new Error("The widget host never mounted");
    return (host as QueryNode).tagName;
  };

  const openCartDialog = (): QueryNode => {
    const dialog = shadow(h).querySelector("dialog");
    if (!dialog) throw new Error("The cart dialog never opened");
    return dialog;
  };

  const countText = (): string => {
    const count = shadow(h).querySelector(".cart-button .count");
    if (!count) throw new Error("The cart count span is missing");
    return count.textContent;
  };

  test("mounts the widget host as a div", () => {
    setBody(h, addLink("open"));
    h.run(singleCatalog());

    expect(hostTag()).toBe("DIV");
  });

  test("renders the cart dialog's exact structure", () => {
    setBody(h, addLink("fixed") + addLink("small"));
    h.run(
      makeCatalog(
        [
          listing({ id: 1, slug: "fixed", unit_price: 1500 }),
          listing({ id: 2, slug: "small", unit_price: 500 }),
        ],
        false,
      ),
    );
    clickAnchor(h, "fixed");
    clickAnchor(h, "small");
    const dialog = openCartDialog();

    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog.querySelector("h2")!.textContent).toBe("Your tickets");

    const rows = Array.from(dialog.querySelectorAll(".row")) as QueryNode[];
    expect(rows.length).toBe(2);
    const [row] = rows;
    expect(row!.tagName).toBe("DIV");
    expect(row!.className).toBe("row");
    expect(one(row!, ".name").tagName).toBe("SPAN");
    expect(one(row!, ".name").className).toBe("name");
    expect(one(row!, ".price").tagName).toBe("SPAN");
    expect(one(row!, ".price").className).toBe("price");
    expect(one(row!, ".stepper").tagName).toBe("SPAN");
    expect(one(row!, ".stepper").className).toBe("stepper");
    expect(one(row!, ".stepper span").tagName).toBe("SPAN");

    // Two fixed lines: the subtotal is the SUM, not the last line's price.
    expect(one(dialog, ".subtotal").className).toBe("subtotal");
    expect(one(dialog, ".subtotal").tagName).toBe("P");
    expect(one(dialog, ".subtotal").textContent).toBe("Subtotal £20");

    expect(one(dialog, ".caveat").className).toBe("caveat");
    expect(one(dialog, ".caveat").tagName).toBe("P");
    expect(one(dialog, ".caveat").textContent).toBe(
      "Final total, fees, and availability are confirmed at checkout.",
    );

    expect(one(dialog, ".continue").className).toBe("continue");
    expect(one(dialog, ".close").className).toBe("close");

    // The cart button: exact class names and both child spans' tags.
    const button = cartButton(h);
    expect(button.className).toBe("cart-button");
    const [label, count] = Array.from(button.children);
    expect(label!.tagName).toBe("SPAN");
    expect(count!.tagName).toBe("SPAN");
    expect(one(button, ".count").className).toBe("count");
  });

  test("renders a dropped-items notice once, with its own class", () => {
    h.window.sessionStorage.setItem(
      `tickets:external-order:v1:${ORIGIN}`,
      JSON.stringify([{ quantity: 1, slug: "gone" }]),
    );
    h.run(singleCatalog());
    const dialog = openCartDialog();

    const notice = one(dialog, ".notice");
    expect(notice.tagName).toBe("P");
    expect(notice.className).toBe("notice");
    expect(notice.textContent).toBe(
      "Some items are no longer available and were removed.",
    );
  });

  test("rejects stored lines with a non-positive quantity outright", () => {
    h.window.sessionStorage.setItem(
      `tickets:external-order:v1:${ORIGIN}`,
      JSON.stringify([{ quantity: 0, slug: "open" }]),
    );
    h.run(singleCatalog());

    // Rejected by the line guard at load, so nothing is "dropped" later and
    // no notice renders — the cart is simply empty.
    expect(shadow(h).querySelector(".notice")).toBeNull();
    expect(countText()).toBe("0");
  });

  test("never enhances a link whose slug collides with an Object key", () => {
    setBody(h, addLink("constructor"));
    h.run(singleCatalog());

    const link = h.document.querySelector('a[data-add-listing*="constructor"]');
    if (!link) throw new Error("The constructor link is missing");
    expect(link.getAttribute("data-chobble-enhanced")).toBeNull();
  });
});
