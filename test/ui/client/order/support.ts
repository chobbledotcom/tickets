import { afterEach, beforeEach } from "@std/testing/bdd";
import { Window } from "happy-dom";
import { orderWidgetBody } from "#routes/assets.ts";
import {
  buildCatalog,
  type CatalogPackage,
  type CatalogSourceListing,
  serializeCatalog,
} from "#shared/external-order.ts";
import { testListing } from "#test-utils/factories.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

export const ORIGIN = "https://tickets.test";
export const MODULE_MARKER = "__orderWidgetModule";

const runnableBody = orderWidgetBody().replace(
  /export\s*\{\s*(\w+)\s+as\s+isExternalOrderModule\s*\}\s*;?\s*$/,
  `;globalThis.${MODULE_MARKER}=$1;`,
);

export const makeCatalog = (
  listings: CatalogSourceListing[],
  debug: boolean,
  packages: CatalogPackage[] = [],
): ReturnType<typeof buildCatalog> =>
  buildCatalog({
    currency: "GBP",
    debug,
    decimalPlaces: 2,
    generatedAt: "2026-06-30T00:00:00Z",
    listings,
    origin: ORIGIN,
    packages,
  });

interface AnimateCall {
  keyframes: unknown;
  options: unknown;
}

export interface Harness {
  animateCalls: AnimateCall[];
  cleanup(): Promise<void>;
  document: Window["document"];
  flush(): Promise<void>;
  focusCalls: number[];
  logs: unknown[][];
  navigations: string[];
  restore(): void;
  run(catalog: ReturnType<typeof makeCatalog>): void;
  setGlobal: ReturnType<typeof createGlobalStash>["set"];
  setReadyState(value: string): void;
  window: Window;
}

export const harness = (): Harness => {
  const window = new Window({ url: `${ORIGIN}/` });
  const document = window.document;
  const logs: unknown[][] = [];
  const navigations: string[] = [];
  const animateCalls: AnimateCall[] = [];
  const focusCalls: number[] = [];

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

  const stash = createGlobalStash();
  const setGlobal = stash.set;
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
    stash.restore();
    delete (globalThis as Record<string, unknown>).__chobbleExternalOrder;
    delete (globalThis as Record<string, unknown>)[MODULE_MARKER];
  };

  return {
    animateCalls,
    cleanup: async (): Promise<void> => {
      await window.happyDOM.abort();
      window.close();
    },
    document,
    flush: (): Promise<void> => window.happyDOM.waitUntilComplete(),
    focusCalls,
    logs,
    navigations,
    restore,
    run: (catalog: ReturnType<typeof makeCatalog>): void => {
      new Function(`${serializeCatalog(catalog)}\n${runnableBody}`)();
    },
    setGlobal,
    setReadyState: (value: string): void => {
      Object.defineProperty(document, "readyState", {
        configurable: true,
        get: () => value,
      });
    },
    window,
  };
};

/** Install the shared per-test lifecycle and expose its active harness. The
 * proxy is read only from test callbacks, after `beforeEach` has created it. */
export const useOrderHarness = (): Harness => {
  let active: Harness;
  beforeEach(() => {
    active = harness();
  });
  afterEach(async () => {
    active.restore();
    await active.cleanup();
  });
  return new Proxy({} as Harness, {
    get: (_target, property) => Reflect.get(active, property),
  });
};

export const listing = (
  overrides: Partial<CatalogSourceListing> & { id: number; slug: string },
): CatalogSourceListing => testListing(overrides);

export const setBody = (h: Harness, html: string): void => {
  h.document.body.innerHTML = html;
};

export const addLink = (slug: string, quantity?: string): string =>
  `<a data-add-listing="${ORIGIN}/ticket/${slug}"${
    quantity === undefined ? "" : ` data-add-quantity="${quantity}"`
  }>Book ${slug}</a>`;

export interface Queryable {
  querySelector(selector: string): QueryNode | null;
  querySelectorAll(selector: string): ArrayLike<QueryNode>;
}

export interface QueryNode extends Queryable {
  click(): void;
  dispatchEvent(event: unknown): boolean;
  getAttribute(name: string): string | null;
  hidden: boolean;
  open: boolean;
  textContent: string;
  type: string;
}

export const hostElOrNull = (h: Harness): Queryable | null =>
  h.document.querySelector("[data-chobble-order]") as Queryable | null;

export const shadow = (h: Harness): Queryable =>
  (hostElOrNull(h) as unknown as { shadowRoot: Queryable }).shadowRoot;

export const cartButton = (h: Harness): QueryNode =>
  shadow(h).querySelector(".cart-button") as QueryNode;

export const dialogEl = (h: Harness): QueryNode =>
  shadow(h).querySelector("dialog") as QueryNode;

export const clickAnchor = (h: Harness, slug: string): boolean => {
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

export const clickIn = (root: Queryable, selector: string): void => {
  (root.querySelector(selector) as QueryNode).click();
};

export const openCart = (h: Harness): QueryNode => {
  cartButton(h).click();
  return dialogEl(h);
};

export const logHas = (h: Harness, first: string): boolean =>
  h.logs.some((entry) => entry[1] === first);

export const buttonType = (root: Queryable, selector: string): string =>
  (root.querySelector(selector) as QueryNode).type;

export const textOf = (root: Queryable, selector: string): string | undefined =>
  (root.querySelector(selector) as QueryNode | null)?.textContent;

export const storedCart = (h: Harness): unknown => {
  const raw = h.window.sessionStorage.getItem(
    `tickets:external-order:v1:${ORIGIN}`,
  );
  return raw === null ? null : JSON.parse(raw);
};

export const mountOpenListing = (h: Harness, debug = false): void => {
  setBody(h, addLink("open"));
  h.run(makeCatalog([listing({ id: 1, slug: "open" })], debug));
};

export const openCartWithOne = (h: Harness): QueryNode => {
  mountOpenListing(h);
  clickAnchor(h, "open");
  return openCart(h);
};

export const stepperButtons = (dialog: Queryable): QueryNode[] =>
  Array.from(dialog.querySelectorAll(".stepper button")) as QueryNode[];

export const stubStorage = (
  h: Harness,
  handlers: {
    getItem: () => string | null;
    removeItem: () => void;
    failSet?: boolean;
  },
): unknown[] => {
  const setCalls: unknown[] = [];
  h.setGlobal("sessionStorage", {
    getItem: handlers.getItem,
    removeItem: handlers.removeItem,
    setItem: (key: string, value: string) => {
      setCalls.push([key, value]);
      if (handlers.failSet) throw new Error("write failed");
    },
  });
  return setCalls;
};
