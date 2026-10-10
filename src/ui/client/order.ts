/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * External order library widget (served as `/order.js`). The server prepends a
 * `const CATALOG = {…};` statement to this module body (see
 * `src/features/public/order-js.ts`).
 *
 * The trailing `export {}` keeps this a true ES module: a disallowed site that
 * loads `/order.js` as a classic `<script>`, past the CORS gate, hits
 * module-only syntax and the browser refuses to run it.
 *
 * Catalog text is rendered with `textContent` and DOM nodes, never `innerHTML`,
 * so an owner's listing name cannot inject markup on a host page.
 */

// Type-only import — erased at bundle time, so it pulls no server code into the
// browser bundle while keeping the catalog shape in one place.
import type {
  Catalog,
  CatalogListing as CatalogEntry,
  CatalogPackage,
} from "#shared/external-order.ts";
import {
  applyStyles,
  buildButton,
  buildCloseButton,
  buildRemovalOnly,
  buildStepper,
  labeledButton,
  setText,
} from "./cart-dom.ts";
import { forEachMatch } from "./dom.ts";

// Injected by the server immediately above this module body.
declare const CATALOG: Catalog;

/** Verbose console logging, gated on the `?debug=true` flag the server bakes
 * into the catalog. Off by default so a production embed stays silent; on, it
 * traces enhancement, cart mutations, and navigation to help an integrator see
 * why their `data-add-listing` links aren't behaving. */
const debugLog = (...args: unknown[]): void => {
  if (CATALOG.debug) console.debug("[chobble-order]", ...args);
};

interface CartLine {
  quantity: number;
  slug: string;
}

/** One cart line with its catalog entry: a priced listing, or a whole package
 *  whose count and price its own page owns. */
type ResolvedLine =
  | { entry: CatalogEntry; kind: "listing"; quantity: number }
  | { entry: CatalogPackage; kind: "package"; quantity: number };

/** Type guard for a stored cart line — used to reject corrupt/foreign values
 * from the host page's sessionStorage. Hand-rolled rather than valibot: this
 * widget ships to external sites, and pulling valibot into the bundle for two
 * tiny checks measured at +1.3 KB gzipped (a ~50% increase). */
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

/** Look up a slug in a catalog record with an own-property check, so inherited
 * Object.prototype keys (`constructor`, `__proto__`, …) never resolve to a
 * bogus entry. */
const catalogRecord = <TEntry>(
  records: Record<string, TEntry>,
  slug: string,
): TEntry | undefined =>
  Object.hasOwn(records, slug) ? records[slug] : undefined;

/** Parse `raw` as a URL, or null when it is not a valid one. */
const parseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

/** The `/ticket/<slug>` slug of a single-listing-or-package URL on the tickets
 * origin, or null when `raw` is not such a URL. A cross-origin, multi-slug, or
 * malformed value falls through to the link's normal navigation. */
const ticketSlug = (raw: string): string | null => {
  const url = parseUrl(raw);
  if (!url || url.origin !== CATALOG.origin) return null;
  return url.pathname.match(/^\/ticket\/([^/+]+)$/)?.[1] ?? null;
};

/** Resolve a `data-add-listing` URL to an entry of `records`, or null when it
 * is not an enhanceable single-slug URL on the tickets origin. */
const resolveEntry = <TEntry>(
  records: Record<string, TEntry>,
  raw: string,
): TEntry | null => {
  const slug = ticketSlug(raw);
  return slug ? (catalogRecord(records, slug) ?? null) : null;
};

/** A package entry carries no listing id: its count and price belong to its
 * own page, so the cart treats it as one bundle. */
const isPackageEntry = (
  entry: CatalogEntry | CatalogPackage,
): entry is CatalogPackage => !("id" in entry);

/** Explain why a `data-add-listing` value can't be enhanced, so the skip log
 * says WHY rather than just naming the link. Mirrors the checks in
 * `ticketSlug` and `resolveEntry`. */
const skipReason = (raw: string): string => {
  if (!raw) return "no data-add-listing value";
  const url = parseUrl(raw);
  if (!url) return "not a valid URL";
  if (url.origin !== CATALOG.origin)
    return `origin ${url.origin} is not the tickets origin ${CATALOG.origin}`;
  const slug = url.pathname.match(/^\/ticket\/([^/+]+)$/)?.[1];
  if (!slug) return `path ${url.pathname} is not a /ticket/<slug> URL`;
  return `slug "${slug}" is not a known listing or package`;
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
    // Persist the reconciled cart so a pruned/normalised list replaces the
    // stale stored value instead of being re-pruned on every navigation.
    this.save();
    const host = document.createElement("div");
    host.setAttribute("data-chobble-order", "");
    document.body.appendChild(host);
    this.root = host.attachShadow({ mode: "open" });
    applyStyles(this.root);
    this.button = buildButton(() => this.open());
    this.dialog = document.createElement("dialog");
    this.dialog.addEventListener("close", () => this.button.focus());
    this.bodyEl = document.createElement("div");
    this.dialog.appendChild(this.bodyEl);
    this.root.append(this.button, this.dialog);
    this.render();
  }

  /** Read the stored cart. A storage *access* failure flips to memory-only,
   * but a corrupt JSON value is just dropped (storage still works). */
  private load(): CartLine[] {
    let raw: string | null;
    try {
      raw = sessionStorage.getItem(this.storageKey);
    } catch {
      this.memoryOnly = true;
      debugLog("sessionStorage unavailable; cart is memory-only");
      return [];
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      // Untrusted host-page state, not app data: keep only well-formed entries
      // so a corrupt value like `[null]` cannot throw in reconcile().
      return Array.isArray(parsed) ? parsed.filter(isCartLine) : [];
    } catch {
      // Bad JSON from the host page — discard it but keep using storage.
      debugLog("discarding corrupt stored cart");
      try {
        sessionStorage.removeItem(this.storageKey);
      } catch {
        this.memoryOnly = true;
      }
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
   * deactivated the listing since the cart was saved) and merge any duplicate
   * lines for the same slug — corrupt/foreign storage could hold both, and a
   * duplicate would otherwise emit `q_<id>` twice in the Continue URL (the
   * ticket page reads only the first). Record a notice when items are dropped. */
  private reconcile(lines: CartLine[]): CartLine[] {
    const merged = new Map<string, number>();
    let dropped = false;
    for (const line of lines) {
      const pkg = catalogRecord(CATALOG.packages, line.slug);
      const listing =
        pkg === undefined
          ? catalogRecord(CATALOG.listings, line.slug)
          : undefined;
      if ((listing === undefined && pkg === undefined) || line.quantity <= 0) {
        dropped = true;
        continue;
      }
      // A package is one bundle per line, so corrupt or doubled stored lines
      // never raise its count past one.
      merged.set(
        line.slug,
        pkg ? 1 : (merged.get(line.slug) ?? 0) + line.quantity,
      );
    }
    if (dropped) {
      this.notice = "Some items are no longer available and were removed.";
      debugLog("reconcile dropped unavailable cart items");
    }
    return [...merged].map(([slug, quantity]) => ({ quantity, slug }));
  }

  add(entry: CatalogEntry | CatalogPackage, quantity = 1): void {
    const existing = this.lines.find((line) => line.slug === entry.slug);
    // A package is one bundle per line — its own page owns the count — so its
    // quantity stays at one however often its link is clicked.
    const added = isPackageEntry(entry)
      ? 1
      : (existing?.quantity ?? 0) + quantity;
    if (existing) {
      existing.quantity = added;
    } else {
      this.lines.push({ quantity: added, slug: entry.slug });
    }
    this.save();
    this.render();
    this.bump();
    debugLog("add", entry.slug, `x${quantity}`, "cart now", this.lines);
  }

  private setQuantity(slug: string, quantity: number): void {
    this.lines = this.lines.flatMap((line) => {
      if (line.slug !== slug) return [line];
      return quantity > 0 ? [{ quantity, slug }] : [];
    });
    this.save();
    this.render();
  }

  private resolved(): ResolvedLine[] {
    return this.lines.flatMap((line): ResolvedLine[] => {
      const listing = catalogRecord(CATALOG.listings, line.slug);
      if (listing) {
        return [{ entry: listing, kind: "listing", quantity: line.quantity }];
      }
      const pkg = catalogRecord(CATALOG.packages, line.slug);
      return pkg
        ? [{ entry: pkg, kind: "package", quantity: line.quantity }]
        : [];
    });
  }

  private continueUrl(): string | null {
    const lines = this.resolved();
    if (lines.length === 0) return null;
    const slugs = lines.map((line) => line.entry.slug).join("+");
    // A package carries no `q_` prefill — its page's count selector already
    // defaults to one bundle, exactly as the internal /order gallery books it.
    const query = lines
      .filter((line) => line.kind === "listing")
      .map((line) => `q_${line.entry.id}=${line.quantity}`)
      .join("&");
    return `${CATALOG.origin}/ticket/${slugs}${
      query.length > 0 ? `?${query}` : ""
    }`;
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
    const count = this.lines.reduce((sum, line) => sum + line.quantity, 0);
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
    for (const item of lines) {
      // A package's price is fixed on its own page, so it keeps the subtotal
      // indicative exactly as a variable-price listing does.
      if (item.kind === "package" || item.entry.variablePrice) {
        hasVariable = true;
      } else {
        subtotal += item.entry.unitPrice * item.quantity;
      }
      this.bodyEl.appendChild(this.renderRow(item));
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

  private renderRow(item: ResolvedLine): HTMLElement {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.entry.name;
    row.appendChild(name);

    const price = document.createElement("span");
    price.className = "price";
    price.textContent =
      item.kind === "package" || item.entry.variablePrice
        ? "Price set at checkout"
        : formatMoney(item.entry.unitPrice * item.quantity);
    row.appendChild(price);

    if (item.kind === "package") {
      // The package page owns the bundle count, so the row offers removal
      // only — no quantity stepper.
      row.appendChild(
        buildRemovalOnly(() => this.setQuantity(item.entry.slug, 0)),
      );
    } else {
      row.appendChild(
        buildStepper(item.quantity, (next) =>
          this.setQuantity(item.entry.slug, next),
        ),
      );
    }
    return row;
  }

  private buildContinue(): HTMLElement {
    const url = this.continueUrl();
    const button = labeledButton("Continue", "continue");
    button.addEventListener("click", () => {
      debugLog("continue ->", url);
      if (url) globalThis.location.assign(url);
    });
    return button;
  }
}

const init = (): void => {
  // The registry is keyed by tickets origin: duplicate tags for the SAME origin
  // reuse one controller, but two different ticket sites on one page each get
  // their own cart (the contract is one cart per tickets origin).
  const global = globalThis as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const registry = global[REGISTRY_KEY] ?? {};
  global[REGISTRY_KEY] = registry;
  if (registry[CATALOG.origin]) {
    debugLog("already initialised for", CATALOG.origin);
    return;
  }

  debugLog("init", {
    listings: Object.keys(CATALOG.listings).length,
    origin: CATALOG.origin,
  });
  const controller = new CartController();
  registry[CATALOG.origin] = controller;

  const enhance = (link: HTMLAnchorElement): void => {
    if (link.dataset.chobbleEnhanced) return;
    const raw = link.dataset.addListing ?? "";
    if (
      !resolveEntry(CATALOG.listings, raw) &&
      !resolveEntry(CATALOG.packages, raw)
    ) {
      debugLog(
        "skipped un-enhanceable link",
        link.dataset.addListing,
        `- ${skipReason(raw)}`,
      );
      return;
    }
    link.dataset.chobbleEnhanced = "1";
    debugLog("enhanced", link.dataset.addListing);
    link.addEventListener("click", (event) => {
      // Re-resolve at click time: an SPA may have repointed `data-add-listing`
      // since enhancement (re-scans skip already-enhanced links). If it now
      // points outside the catalog, fall through to normal navigation.
      const current = link.dataset.addListing ?? "";
      const entry =
        resolveEntry(CATALOG.listings, current) ??
        resolveEntry(CATALOG.packages, current);
      if (entry) {
        event.preventDefault();
        controller.add(entry, parseAddQuantity(link.dataset.addQuantity));
      }
    });
  };

  const scan = (): void =>
    forEachMatch<HTMLAnchorElement>("a[data-add-listing]", enhance);

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
