import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  addScreenshotStyle,
  withWholePaintGroups,
} from "#scripts/screenshots/layers.ts";
import {
  createDomInstaller,
  createGlobalStash,
} from "#test-utils/happy-dom.ts";

type LinkEvent = "error" | "load";

interface FakeLink {
  addEventListener: (event: LinkEvent, listener: () => void) => void;
  dataset: Record<string, string>;
  href: string;
  rel: string;
  remove: () => void;
  removed: boolean;
  send: (event: LinkEvent) => void;
}

interface FakeRoot {
  appendChild: (link: FakeLink) => void;
  links: FakeLink[];
  querySelectorAll: (selector: string) => unknown[];
}

interface FakePaintStyle {
  backgroundClip: string;
  content: string;
  display: string;
  filter: string;
  getPropertyValue: (name: string) => string;
  maskImage: string;
  mixBlendMode: string;
  opacity: string;
  visibility: string;
}

interface FakePaintElement {
  attributes: Set<string>;
  getRootNode: () => unknown;
  hasAttribute: (name: string) => boolean;
  matches: () => boolean;
  parentElement: FakePaintElement | null;
  pseudos: Record<string, FakePaintStyle>;
  removeAttribute: (name: string) => void;
  root: unknown;
  setAttribute: (name: string) => void;
  shadowRoot: FakePaintRoot | null;
  style: FakePaintStyle;
}

interface PaintStyleOptions
  extends Partial<Omit<FakePaintStyle, "getPropertyValue">> {
  webkitBackgroundClip?: string;
  webkitMaskImage?: string;
}

const makePaintStyle = (options: PaintStyleOptions = {}): FakePaintStyle => {
  const {
    webkitBackgroundClip = "border-box",
    webkitMaskImage = "none",
    ...overrides
  } = options;
  return {
    backgroundClip: "border-box",
    content: '"paint"',
    display: "block",
    filter: "none",
    getPropertyValue: (name) =>
      name === "-webkit-background-clip"
        ? webkitBackgroundClip
        : name === "-webkit-mask-image"
          ? webkitMaskImage
          : "",
    maskImage: "none",
    mixBlendMode: "normal",
    opacity: "1",
    visibility: "visible",
    ...overrides,
  };
};

class FakePaintRoot {
  readonly childNodes = [];

  constructor(
    readonly host: FakePaintElement,
    readonly elements: FakePaintElement[],
  ) {}

  querySelectorAll(selector: string): FakePaintElement[] {
    return selector === "*" ? this.elements : [];
  }
}

const makePaintElement = (
  style: PaintStyleOptions = {},
  matchesControl = false,
): FakePaintElement => {
  const attributes = new Set<string>();
  const element: FakePaintElement = {
    attributes,
    getRootNode: () => element.root,
    hasAttribute: (name) => attributes.has(name),
    matches: () => matchesControl,
    parentElement: null,
    pseudos: {
      "::after": makePaintStyle({ content: '"after"', display: "none" }),
      "::before": makePaintStyle({ content: "none" }),
    },
    removeAttribute: (name) => attributes.delete(name),
    root: null,
    setAttribute: (name) => attributes.add(name),
    shadowRoot: null,
    style: makePaintStyle(style),
  };
  return element;
};

const evaluationPage = {
  evaluate: (fn: (argument: never) => unknown, argument: never) =>
    Promise.resolve(fn(argument)),
} as never;

const makeLink = (): FakeLink => {
  const listeners = new Map<LinkEvent, () => void>();
  const link: FakeLink = {
    addEventListener: (event, listener) => listeners.set(event, listener),
    dataset: {},
    href: "",
    rel: "",
    remove: () => {
      link.removed = true;
    },
    removed: false,
    send: (event) => listeners.get(event)?.(),
  };
  return link;
};

const makeRoot = (event: LinkEvent, children: FakeRoot[] = []): FakeRoot => {
  const links: FakeLink[] = [];
  return {
    appendChild: (link) => {
      links.push(link);
      queueMicrotask(() => link.send(event));
    },
    links,
    querySelectorAll: (selector) =>
      selector === "*" ? children.map((shadowRoot) => ({ shadowRoot })) : links,
  };
};

const setupPage = (
  root: FakeRoot,
): {
  globals: ReturnType<typeof createGlobalStash>;
  page: never;
  styleRemoved: () => boolean;
  unrouted: () => boolean;
} => {
  const globals = createGlobalStash();
  globals.set("document", {
    createElement: makeLink,
    querySelectorAll: root.querySelectorAll,
  });
  let removedStyle = false;
  let removedRoute = false;
  return {
    globals,
    page: {
      addStyleTag: () =>
        Promise.resolve({
          evaluate: (fn: (node: unknown) => unknown) =>
            Promise.resolve(
              fn({
                parentNode: {
                  removeChild: () => {
                    removedStyle = true;
                  },
                },
              }),
            ),
        }),
      evaluate: (fn: (argument: never) => unknown, argument: never) =>
        Promise.resolve(fn(argument)),
      route: () => Promise.resolve(),
      unroute: () => {
        removedRoute = true;
        return Promise.resolve();
      },
      url: () => "https://tickets.test/page",
    } as never,
    styleRemoved: () => removedStyle,
    unrouted: () => removedRoute,
  };
};

describe("screenshot layer styles", () => {
  let pageGlobals: ReturnType<typeof createGlobalStash> | undefined;

  afterEach(() => {
    pageGlobals?.restore();
    pageGlobals = undefined;
  });

  test("loads and removes styles in nested open shadow roots", async () => {
    const nested = makeRoot("load");
    const shadow = makeRoot("load", [nested]);
    const documentRoot = makeRoot("load", [shadow]);
    const state = setupPage(documentRoot);
    pageGlobals = state.globals;

    const remove = await addScreenshotStyle(
      state.page,
      "button { color: red; }",
    );
    expect(shadow.links).toHaveLength(1);
    expect(nested.links).toHaveLength(1);
    expect(shadow.links[0]).toEqual(
      expect.objectContaining({ rel: "stylesheet", removed: false }),
    );

    await remove();

    expect(shadow.links[0]?.removed).toBe(true);
    expect(nested.links[0]?.removed).toBe(true);
    expect(state.styleRemoved()).toBe(true);
    expect(state.unrouted()).toBe(true);
  });

  test("cleans up when a shadow-root stylesheet fails to load", async () => {
    const shadow = makeRoot("error");
    const state = setupPage(makeRoot("load", [shadow]));
    pageGlobals = state.globals;

    await expect(
      addScreenshotStyle(state.page, "button { color: red; }"),
    ).rejects.toThrow("Could not load screenshot style.");

    expect(shadow.links[0]?.removed).toBe(true);
    expect(state.styleRemoved()).toBe(true);
    expect(state.unrouted()).toBe(true);
  });

  test("wraps direct root text only while layer marks are active", async () => {
    const dom = createDomInstaller(["ShadowRoot", "getComputedStyle"]);
    const window = dom.installDom("Words <p>Element</p>   ");
    const originalText = window.document.body.firstChild;
    if (!originalText) throw new Error("Missing root text fixture.");
    try {
      await withWholePaintGroups(evaluationPage, () => {
        const wrapper = window.document.body.firstElementChild;
        expect(wrapper?.getAttribute("data-screenshot-root-text")).toBe("");
        expect(wrapper?.textContent).toBe("Words ");
        expect(window.document.body.lastChild?.nodeType).toBe(3);
        return Promise.resolve();
      });

      expect(window.document.body.firstChild).toBe(originalText);
      expect(window.document.body.textContent).toBe("Words Element   ");
    } finally {
      await dom.cleanup();
    }
  });

  test("marks paint groups and visible controls across composed trees", async () => {
    const globals = createGlobalStash();
    const whole = makePaintElement({ opacity: "0.5" });
    const wholeChild = makePaintElement();
    wholeChild.parentElement = whole;
    const wholeGrandchild = makePaintElement();
    wholeGrandchild.parentElement = wholeChild;
    const text = makePaintElement({
      webkitBackgroundClip: "border-box, text",
    });
    const textChild = makePaintElement();
    textChild.parentElement = text;
    const controlHost = makePaintElement({}, true);
    controlHost.parentElement = wholeGrandchild;
    const shadowControlChild = makePaintElement();
    const shadowRoot = new FakePaintRoot(controlHost, [shadowControlChild]);
    controlHost.shadowRoot = shadowRoot;
    shadowControlChild.root = shadowRoot;
    const hiddenControl = makePaintElement({ visibility: "hidden" }, true);
    const generatedWhole = makePaintElement();
    generatedWhole.pseudos["::before"] = makePaintStyle({
      filter: "blur(1px)",
    });
    const generatedText = makePaintElement();
    generatedText.pseudos["::before"] = makePaintStyle({
      backgroundClip: "text",
    });
    const masked = makePaintElement({
      webkitMaskImage: "linear-gradient(black, transparent)",
    });
    const plain = makePaintElement();
    const topLevel = [
      whole,
      wholeChild,
      wholeGrandchild,
      text,
      textChild,
      controlHost,
      hiddenControl,
      generatedWhole,
      generatedText,
      masked,
      plain,
    ];
    const root = { childNodes: [] };
    const documentRoot = {
      body: root,
      documentElement: root,
      querySelectorAll: (selector: string) =>
        selector === "*" ? topLevel : [],
    };
    for (const element of topLevel) element.root = documentRoot;
    globals.set("ShadowRoot", FakePaintRoot);
    globals.set("document", documentRoot);
    globals.set(
      "getComputedStyle",
      (element: FakePaintElement, pseudo?: string) =>
        pseudo ? element.pseudos[pseudo] : element.style,
    );
    try {
      await withWholePaintGroups(evaluationPage, () => {
        expect([...whole.attributes]).toEqual(["data-screenshot-whole-paint"]);
        expect([...wholeChild.attributes]).toEqual([]);
        expect([...wholeGrandchild.attributes]).toEqual([]);
        expect([...text.attributes]).toEqual(["data-screenshot-text-paint"]);
        expect([...textChild.attributes]).toEqual([]);
        expect(
          controlHost.attributes.has("data-screenshot-visible-control"),
        ).toBe(true);
        expect(
          shadowControlChild.attributes.has("data-screenshot-visible-control"),
        ).toBe(true);
        expect(
          shadowControlChild.attributes.has("data-screenshot-whole-paint"),
        ).toBe(true);
        expect(hiddenControl.attributes.size).toBe(0);
        expect(
          generatedWhole.attributes.has("data-screenshot-whole-paint"),
        ).toBe(true);
        expect(generatedText.attributes.has("data-screenshot-text-paint")).toBe(
          true,
        );
        expect(masked.attributes.has("data-screenshot-whole-paint")).toBe(true);
        expect(plain.attributes.size).toBe(0);
        return Promise.resolve();
      });

      expect(topLevel.every((element) => element.attributes.size === 0)).toBe(
        true,
      );
      expect(shadowControlChild.attributes.size).toBe(0);
    } finally {
      globals.restore();
    }
  });
});
