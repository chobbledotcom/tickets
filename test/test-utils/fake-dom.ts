/** Minimal fake DOM for the booking-page client scripts.
 *
 * The client enhancement modules query a small, fixed vocabulary of selectors
 * (`[name^="quantity_"]`, `[name^="child_qty_<parentId>_"]`,
 * `fieldset.child-selector[data-parent-id]`, `.custom-question[data-listing-ids]`,
 * control-type lists inside a question, …). Rather than pull in a full DOM, this
 * builds plain element objects and a `document` whose query methods interpret
 * those selectors, so tests assert real outcomes (a control's `required`/`hidden`
 * flag flips) the way the existing custom-question-visibility test does. */

export type FakeElement = {
  tag: string;
  classes: Set<string>;
  attrs: Map<string, string>;
  /** Form-control state the scripts read/write. */
  type?: string | undefined;
  value: string;
  checked: boolean;
  required: boolean;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  dataset: Record<string, string>;
  children: FakeElement[];
  getAttribute: (name: string) => string | null;
  /** Add (force=true) or remove (force=false) a boolean-ish attribute, mirroring
   * the DOM `Element.toggleAttribute(name, force)` the scripts use to flag a
   * sole-child block incompatible (Fix 1). */
  toggleAttribute: (name: string, force: boolean) => void;
  querySelectorAll: (selector: string) => FakeElement[];
  addEventListener: (event: string, listener: () => void) => void;
  /** Dispatch a real `Event` to the registered listeners (the production scripts
   * call this to notify dependents — Fix 2). Returns true like the DOM API. */
  dispatchEvent: (event: Event) => boolean;
  /** Fire a registered listener by name (test-only convenience). */
  dispatch: (event: string) => void;
};

export type ElementSpec = {
  tag?: string;
  class?: string;
  name?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  required?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  data?: Record<string, string> | undefined;
  children?: ElementSpec[];
};

/** A parsed simple selector clause (one comma-separated alternative). */
type Clause = {
  tag?: string | undefined;
  class?: string | undefined;
  type?: string | undefined;
  namePrefix?: string | undefined;
  nameExact?: string | undefined;
  dataKey?: string | undefined;
  dataValue?: string | undefined;
  checked: boolean;
};

const parseClause = (raw: string): Clause => {
  const clause: Clause = { checked: false };
  let rest = raw.trim();
  if (rest.endsWith(":checked")) {
    clause.checked = true;
    rest = rest.slice(0, -":checked".length);
  }
  const tagMatch = rest.match(/^[a-z]+/);
  if (tagMatch) {
    clause.tag = tagMatch[0];
    rest = rest.slice(tagMatch[0].length);
  }
  for (const m of rest.matchAll(/\.([a-z-]+)/g)) clause.class = m[1];
  const prefix = rest.match(/\[name\^="([^"]+)"\]/);
  if (prefix) clause.namePrefix = prefix[1];
  const exact = rest.match(/\[name="([^"]+)"\]/);
  if (exact) clause.nameExact = exact[1];
  const typeAttr = rest.match(/\[type="([^"]+)"\]/);
  if (typeAttr) clause.type = typeAttr[1];
  const dataAttrValue = rest.match(/\[data-([a-z-]+)="([^"]+)"\]/);
  if (dataAttrValue) {
    clause.dataKey = dataAttrValue[1];
    clause.dataValue = dataAttrValue[2];
  } else {
    const dataAttr = rest.match(/\[data-([a-z-]+)\]/);
    if (dataAttr) clause.dataKey = dataAttr[1];
  }
  return clause;
};

const matchesClause = (el: FakeElement, clause: Clause): boolean => {
  if (clause.tag && el.tag !== clause.tag) return false;
  if (clause.class && !el.classes.has(clause.class)) return false;
  if (clause.type && el.type !== clause.type) return false;
  if (clause.checked && !el.checked) return false;
  const name = el.attrs.get("name") ?? "";
  if (clause.namePrefix && !name.startsWith(clause.namePrefix)) return false;
  if (clause.nameExact && name !== clause.nameExact) return false;
  if (clause.dataKey) {
    const dataVal = el.getAttribute(`data-${clause.dataKey}`);
    if (dataVal === null) return false;
    if (clause.dataValue !== undefined && dataVal !== clause.dataValue) {
      return false;
    }
  }
  return true;
};

const matchesSelector = (el: FakeElement, selector: string): boolean =>
  selector.split(",").some((alt) => matchesClause(el, parseClause(alt)));

const datasetKey = (attr: string): string =>
  attr.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const makeElement = (spec: ElementSpec): FakeElement => {
  const listeners = new Map<string, (() => void)[]>();
  const attrs = new Map<string, string>();
  if (spec.name !== undefined) attrs.set("name", spec.name);
  for (const [k, v] of Object.entries(spec.data ?? {})) {
    attrs.set(`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v);
  }
  const dataset: Record<string, string> = {};
  for (const [attr, val] of attrs) {
    if (attr.startsWith("data-")) dataset[datasetKey(attr)] = val;
  }
  const children = (spec.children ?? []).map(makeElement);
  const el: FakeElement = {
    addEventListener: (event, listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    attrs,
    checked: spec.checked ?? false,
    children,
    classes: new Set(spec.class ? spec.class.split(" ") : []),
    dataset,
    disabled: spec.disabled ?? false,
    dispatch: (event) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    dispatchEvent: (event) => {
      for (const listener of listeners.get(event.type) ?? []) listener();
      return true;
    },
    getAttribute: (name) => attrs.get(name) ?? null,
    hidden: spec.hidden ?? false,
    querySelectorAll: (selector) =>
      collect(children).filter((c) => matchesSelector(c, selector)),
    required: spec.required ?? false,
    tag: spec.tag ?? "input",
    textContent: "",
    toggleAttribute: (name, force) => {
      if (force) {
        attrs.set(name, "");
        if (name.startsWith("data-")) dataset[datasetKey(name)] = "";
      } else {
        attrs.delete(name);
        if (name.startsWith("data-")) delete dataset[datasetKey(name)];
      }
    },
    type: spec.type,
    value: spec.value ?? "",
  };
  return el;
};

const collect = (roots: FakeElement[]): FakeElement[] => {
  const all: FakeElement[] = [];
  const walk = (el: FakeElement): void => {
    all.push(el);
    for (const child of el.children) walk(child);
  };
  for (const root of roots) walk(root);
  return all;
};

/** Booking-form element-spec builders shared by the client-script tests. */
export const quantitySpec = (id: string, value: string): ElementSpec => ({
  name: `quantity_${id}`,
  tag: "select",
  value,
});

/** The package-page `name="package_quantity"` selector, carrying its member
 * listing ids in `data-package-members` so the active-listing set picks up every
 * member once a package is chosen (even when members render no rows). */
export const packageSelectorSpec = (
  memberIds: string[],
  value: string,
): ElementSpec => ({
  data: { packageMembers: memberIds.join(" ") },
  name: "package_quantity",
  tag: "select",
  value,
});

/** An auto-hidden parent quantity (`<input type="hidden" name="quantity_<id>"
 * value="1">`), the shape a single-parent sole-child page renders when the
 * quantity selector is suppressed (`hideQuantity`). Defaults to "1", matching the
 * server template, so a test can assert it is restored after a compatible
 * selection returns (Fix 5). */
export const hiddenQuantitySpec = (id: string, value = "1"): ElementSpec => ({
  name: `quantity_${id}`,
  tag: "input",
  type: "hidden",
  value,
});

/** A parent's child-selector fieldset. `packageFixedQty` models a PACKAGE
 * member parent, which has no own quantity control: the server stamps its fixed
 * per-package quantity on the fieldset so the client derives its booked units
 * from the chosen package count. */
export const childSelectorSpec = (
  parentId: string,
  packageFixedQty?: number,
): ElementSpec => ({
  class: "child-selector",
  data: {
    parentId,
    ...(packageFixedQty !== undefined && {
      packageFixedQty: String(packageFixedQty),
    }),
  },
  tag: "fieldset",
});

/** The date/span compatibility attributes a bookable child carries (Codex 430,
 * Fix 4). `data-child-dates` is the span-keyed wire shape `span:d,d|span:d,d`
 * (`encodeChildSpanDates`). `dates` is given as span → dates (a single span when
 * the parent is fixed-duration); a flat `string[]` is sugar for one span "1".
 * `spans` are the supported day counts. */
export type ChildCompat = {
  dates?: string[] | Record<string, string[]>;
  spans?: number[];
};

/** Encode the `data-child-dates` attribute value from a {@link ChildCompat}
 * `dates` spec, mirroring the server's `encodeChildSpanDates`. */
const encodeCompatDates = (
  dates: string[] | Record<string, string[]>,
): string =>
  Array.isArray(dates)
    ? `1:${dates.join(",")}`
    : Object.entries(dates)
        .map(([span, ds]) => `${span}:${ds.join(",")}`)
        .join("|");

const compatData = (
  childId: string,
  compat: ChildCompat,
): Record<string, string> => ({
  childQty: childId,
  ...(compat.dates && { childDates: encodeCompatDates(compat.dates) }),
  ...(compat.spans && { childSpans: compat.spans.join(",") }),
});

/** A per-child quantity select (`child_qty_<parentId>_<childId>`), the per-unit
 * selection control that replaced the old radio. `value` is the chosen quantity
 * (default "0"); a disabled control models a sold-out child.
 *
 * `compat` adds the date/span compatibility attributes the server emits for a
 * BOOKABLE child (Codex 430): `data-child-qty` (the JS-managed marker) plus the
 * optional `data-child-dates` / `data-child-spans`. A server-disabled (sold-out)
 * child renders WITHOUT `data-child-qty`, so omit `compat` to model one. */
export const childQtySpec = (
  parentId: string,
  childId: string,
  value = "0",
  disabled = false,
  compat?: ChildCompat,
): ElementSpec => ({
  data: compat ? compatData(childId, compat) : undefined,
  disabled,
  name: `child_qty_${parentId}_${childId}`,
  tag: "select",
  value,
});

/** A sole auto-selected child's informational marker (`renderSoleChildOption`):
 * a `data-sole-parent`/`data-sole-child` element with NO `child_qty_*` control,
 * so the active-listing set must pick it up from the parent being in the cart
 * alone (Fix 1). `compat` adds the same `data-child-dates` / `data-child-spans`
 * the server now emits on the marker so the compatibility script can flag the
 * parent when the sole child can't serve the selection (Fix 1). */
export const soleChildSpec = (
  parentId: string,
  childId: string,
  compat?: ChildCompat,
): ElementSpec => ({
  class: "child-option child-sole",
  data: {
    soleChild: childId,
    soleParent: parentId,
    ...(compat?.dates && { childDates: encodeCompatDates(compat.dates) }),
    ...(compat?.spans && { childSpans: compat.spans.join(",") }),
  },
  tag: "p",
});

/** The page-level `name="date"` daily-listing date selector. */
export const dateSpec = (value = ""): ElementSpec => ({
  name: "date",
  tag: "select",
  value,
});

/** The page-level `name="day_count"` span selector. */
export const dayCountSpec = (value = ""): ElementSpec => ({
  name: "day_count",
  tag: "select",
  value,
});

/** The per-parent "X of Q chosen" hint span the JS updates. */
export const childHintSpec = (parentId: string): ElementSpec => ({
  data: { childHint: parentId },
  tag: "span",
});

export const childPriceSpec = (
  parentId: string,
  childId: string,
): ElementSpec => ({
  name: `child_price_${parentId}_${childId}`,
  required: false,
  tag: "input",
  type: "text",
});

const originalDocument = globalThis.document;

/** Install a fake `document` whose body is the given element specs, returning
 * the built root elements. Call `restoreDocument()` in test teardown. */
export const installFakeDom = (specs: ElementSpec[]): FakeElement[] => {
  const roots = specs.map(makeElement);
  const all = collect(roots);
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: (selector: string) =>
        all.find((el) => matchesSelector(el, selector)) ?? null,
      querySelectorAll: (selector: string) =>
        all.filter((el) => matchesSelector(el, selector)),
    } as unknown as Document,
  });
  return roots;
};

/** Restore the real `document`. Safe to call when none was installed. */
export const restoreDocument = (): void => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument,
  });
};

/** Find a {@link FakeElement} in `roots` by its `name` attribute. */
export const byName = (roots: FakeElement[], name: string): FakeElement =>
  roots.find((root) => root.attrs.get("name") === name)!;
