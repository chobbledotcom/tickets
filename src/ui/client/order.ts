/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * External order library widget (served as `/order.js`).
 *
 * Turns `data-add-listing` links on an external site into add-to-cart controls
 * for tickets hosted by this app, then hands off to the canonical ticket page.
 * The listing catalog is injected by the server as a `const CATALOG = {…};`
 * statement prepended to this module body (see
 * `src/features/public/order-js.ts`).
 *
 * The trailing `export {}` keeps this a true ES module: a disallowed site that
 * tries to load `/order.js` as a classic `<script>` (bypassing the CORS gate)
 * hits module-only syntax and the browser refuses to run it.
 *
 * All catalog-derived text is rendered with `textContent` / DOM nodes, never
 * `innerHTML`, so an owner's listing name cannot inject markup on a host page.
 */

// Type-only import — erased at bundle time, so it pulls no server code into the
// browser bundle while keeping the catalog shape in one place.
import type {
  Catalog,
  CatalogListing as CatalogEntry,
} from "#shared/external-order.ts";

// Injected by the server immediately above this module body.
declare const CATALOG: Catalog;

interface CartLine {
  slug: string;
  quantity: number;
}

/** Type guard for a stored cart line — used to reject corrupt/foreign values
 * from the host page's sessionStorage. */
const isCartLine = (value: unknown): value is CartLine => {
  const line = value as Partial<CartLine> | null;
  return (
    typeof line === "object" &&
    line !== null &&
    typeof line.slug === "string" &&
    typeof line.quantity === "number" &&
    Number.isInteger(line.quantity) &&
    line.quantity > 0
  );
};

/** Parse a `data-add-quantity` attribute. Defaults to 1; invalid, zero,
 * negative, or fractional values are treated as 1 (per the spec). */
const parseAddQuantity = (raw: string | undefined): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

const STORAGE_PREFIX = "tickets:external-order:v1:";
const REGISTRY_KEY = "__chobbleExternalOrder";
const NUMBER_LOCALE = "en";

/** Format minor units the same way the server's `formatCurrency` does, so the
 * widget shows the same numbers as the canonical pages. */
const formatMoney = (minorUnits: number): string =>
  new Intl.NumberFormat(NUMBER_LOCALE, {
    currency: CATALOG.currency,
    style: "currency",
    trailingZeroDisplay: "stripIfInteger",
  }).format(minorUnits / 10 ** CATALOG.decimalPlaces);

/** Resolve a `data-add-listing` URL to a catalog entry, or null if it is not an
 * enhanceable single-listing URL on the tickets origin. */
const resolveListing = (raw: string): CatalogEntry | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== CATALOG.origin) return null;
  const slug = url.pathname.match(/^\/ticket\/([^/+]+)$/)?.[1];
  if (!slug) return null;
  return CATALOG.listings[slug] ?? null;
};

class CartController {
  private lines: CartLine[];
  private readonly storageKey = STORAGE_PREFIX + CATALOG.origin;
  private root: ShadowRoot;
  private button: HTMLButtonElement;
  private dialog: HTMLDialogElement;
  private bodyEl: HTMLDivElement;
  private notice = "";
  private memoryOnly = false;

  constructor() {
    this.lines = this.reconcile(this.load());
    const host = document.createElement("div");
    host.setAttribute("data-chobble-order", "");
    document.body.appendChild(host);
    this.root = host.attachShadow({ mode: "open" });
    this.root.appendChild(buildStyles());
    this.button = buildButton(() => this.open());
    this.dialog = document.createElement("dialog");
    this.dialog.addEventListener("close", () => this.button.focus());
    this.bodyEl = document.createElement("div");
    this.dialog.appendChild(this.bodyEl);
    this.root.append(this.button, this.dialog);
    this.render();
  }

  /** Read the stored cart; returns [] if storage is unavailable. */
  private load(): CartLine[] {
    try {
      const raw = sessionStorage.getItem(this.storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      // This is untrusted host-page state, not app data: keep only well-formed
      // entries so a corrupt value like `[null]` cannot throw in reconcile().
      return Array.isArray(parsed) ? parsed.filter(isCartLine) : [];
    } catch {
      this.memoryOnly = true;
      return [];
    }
  }

  private save(): void {
    if (this.memoryOnly) return;
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify(this.lines));
    } catch {
      this.memoryOnly = true;
    }
  }

  /** Drop stored slugs no longer present in the catalog (owner hid, removed, or
   * deactivated the listing since the cart was saved); record a notice if so. */
  private reconcile(lines: CartLine[]): CartLine[] {
    const kept = lines.filter(
      (line) => CATALOG.listings[line.slug] !== undefined && line.quantity > 0,
    );
    if (kept.length < lines.length) {
      this.notice = "Some items are no longer available and were removed.";
    }
    return kept;
  }

  add(entry: CatalogEntry, quantity = 1): void {
    const existing = this.lines.find((line) => line.slug === entry.slug);
    if (existing) {
      existing.quantity += quantity;
    } else {
      this.lines.push({ quantity, slug: entry.slug });
    }
    this.save();
    this.render();
    this.bump();
  }

  private setQuantity(slug: string, quantity: number): void {
    this.lines = this.lines.flatMap((line) => {
      if (line.slug !== slug) return [line];
      return quantity > 0 ? [{ quantity, slug }] : [];
    });
    this.save();
    this.render();
  }

  private resolved(): { entry: CatalogEntry; quantity: number }[] {
    return this.lines.flatMap((line) => {
      const entry = CATALOG.listings[line.slug];
      return entry ? [{ entry, quantity: line.quantity }] : [];
    });
  }

  private totalQuantity(): number {
    return this.lines.reduce((sum, line) => sum + line.quantity, 0);
  }

  private continueUrl(): string | null {
    const lines = this.resolved();
    if (lines.length === 0) return null;
    const slugs = lines.map((l) => l.entry.slug).join("+");
    const query = lines.map((l) => `q_${l.entry.id}=${l.quantity}`).join("&");
    return `${CATALOG.origin}/ticket/${slugs}?${query}`;
  }

  private open(): void {
    this.render();
    this.dialog.showModal();
  }

  private bump(): void {
    this.button.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(1.15)" },
        { transform: "scale(1)" },
      ],
      { duration: 200 },
    );
  }

  /** Rebuild the button label and (if open) the dialog body. */
  private render(): void {
    const count = this.totalQuantity();
    this.button.hidden = count === 0;
    this.button.setAttribute(
      "aria-label",
      `View ticket cart, ${count} item${count === 1 ? "" : "s"}`,
    );
    setText(this.button.querySelector(".count"), String(count));
    this.renderBody();
  }

  private renderBody(): void {
    this.bodyEl.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "Your tickets";
    this.bodyEl.appendChild(heading);

    if (this.notice) {
      const p = document.createElement("p");
      p.className = "notice";
      p.textContent = this.notice;
      this.bodyEl.appendChild(p);
      this.notice = "";
    }

    const lines = this.resolved();
    let subtotal = 0;
    let hasVariable = false;
    for (const { entry, quantity } of lines) {
      if (entry.variablePrice) hasVariable = true;
      else subtotal += entry.unitPrice * quantity;
      this.bodyEl.appendChild(this.renderRow(entry, quantity));
    }

    if (lines.length > 0) {
      const total = document.createElement("p");
      total.className = "subtotal";
      total.textContent = hasVariable
        ? `Subtotal from ${formatMoney(subtotal)}`
        : `Subtotal ${formatMoney(subtotal)}`;
      this.bodyEl.appendChild(total);
      const caveat = document.createElement("p");
      caveat.className = "caveat";
      caveat.textContent =
        "Final total, fees, and availability are confirmed at checkout.";
      this.bodyEl.appendChild(caveat);
      this.bodyEl.appendChild(this.buildContinue());
    } else {
      const empty = document.createElement("p");
      empty.textContent = "Your cart is empty.";
      this.bodyEl.appendChild(empty);
    }

    this.bodyEl.appendChild(buildCloseButton(() => this.dialog.close()));
  }

  private renderRow(entry: CatalogEntry, quantity: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    row.appendChild(name);

    const price = document.createElement("span");
    price.className = "price";
    price.textContent = entry.variablePrice
      ? "Price set at checkout"
      : formatMoney(entry.unitPrice * quantity);
    row.appendChild(price);

    row.appendChild(
      buildStepper(quantity, (next) => this.setQuantity(entry.slug, next)),
    );
    return row;
  }

  private buildContinue(): HTMLElement {
    const url = this.continueUrl();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "continue";
    button.textContent = "Continue";
    button.addEventListener("click", () => {
      if (url) globalThis.location.assign(url);
    });
    return button;
  }
}

/** Set an element's text content if the element exists (escaping-safe). */
const setText = (el: Element | null, text: string): void => {
  if (el) el.textContent = text;
};

const buildButton = (onOpen: () => void): HTMLButtonElement => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cart-button";
  button.hidden = true;
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = "0";
  const label = document.createElement("span");
  label.textContent = "Tickets ";
  button.append(label, count);
  button.addEventListener("click", onOpen);
  return button;
};

const buildCloseButton = (onClose: () => void): HTMLElement => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "close";
  button.textContent = "Close";
  button.addEventListener("click", onClose);
  return button;
};

const buildStepper = (
  quantity: number,
  onChange: (next: number) => void,
): HTMLElement => {
  const wrap = document.createElement("span");
  wrap.className = "stepper";
  const dec = document.createElement("button");
  dec.type = "button";
  dec.textContent = "−";
  dec.setAttribute("aria-label", "Decrease quantity");
  dec.addEventListener("click", () => onChange(quantity - 1));
  const value = document.createElement("span");
  value.textContent = String(quantity);
  const inc = document.createElement("button");
  inc.type = "button";
  inc.textContent = "+";
  inc.setAttribute("aria-label", "Increase quantity");
  inc.addEventListener("click", () => onChange(quantity + 1));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => onChange(0));
  wrap.append(dec, value, inc, remove);
  return wrap;
};

const buildStyles = (): HTMLStyleElement => {
  const style = document.createElement("style");
  style.textContent = `
    .cart-button { position: fixed; right: 1rem; bottom: 1rem; padding: .75rem 1rem;
      border: 0; border-radius: 999px; background: #1a1a1a; color: #fff; cursor: pointer; }
    dialog { border: 0; border-radius: .5rem; padding: 1.25rem; max-width: 28rem; }
    .row { display: flex; gap: .5rem; align-items: center; justify-content: space-between;
      padding: .25rem 0; }
    .stepper button { margin: 0 .15rem; }
    .subtotal { font-weight: 700; }
    .caveat { font-size: .85em; opacity: .8; }
    .continue { display: block; width: 100%; margin-top: .75rem; padding: .6rem;
      border: 0; border-radius: .35rem; background: #1a1a1a; color: #fff; cursor: pointer; }
  `;
  return style;
};

const init = (): void => {
  // The registry is keyed by tickets origin: duplicate tags for the SAME origin
  // reuse one controller, but two different ticket sites on one page each get
  // their own cart (the contract is one cart per tickets origin).
  const global = globalThis as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const registry = (global[REGISTRY_KEY] ??= {});
  if (registry[CATALOG.origin]) return;

  const controller = new CartController();
  registry[CATALOG.origin] = controller;

  const enhance = (link: HTMLAnchorElement): void => {
    if (link.dataset.chobbleEnhanced) return;
    const entry = resolveListing(link.dataset.addListing ?? "");
    if (!entry) return;
    link.dataset.chobbleEnhanced = "1";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      controller.add(entry, parseAddQuantity(link.dataset.addQuantity));
    });
  };

  const scan = (): void => {
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      "a[data-add-listing]",
    )) {
      enhance(link);
    }
  };

  scan();
  new MutationObserver(scan).observe(document.body, {
    childList: true,
    subtree: true,
  });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// A named export (not a bare `export {}`, which the minifier drops) so the
// served bundle keeps module-only syntax: a disallowed site that loads
// `/order.js` as a classic `<script>` to bypass the CORS gate then hits ESM
// syntax and the browser refuses to run it.
export function isExternalOrderModule(): boolean {
  return true;
}
