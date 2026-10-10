/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The order widget's DOM parts: the element factories its rows and chrome
 * share, plus the scoped styles for its shadow root. The parts are pure
 * element-in and element-out code. The controller in `order.ts` owns the
 * cart state and the storage behind it.
 */

import { createButton } from "./dom.ts";

/** Set an element's text content if the element exists (escaping-safe). */
export const setText = (el: Element | null, text: string): void => {
  if (el) el.textContent = text;
};

export const buildButton = (onOpen: () => void): HTMLButtonElement => {
  const button = createButton("cart-button");
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

/** A typed button showing `label`. The builders wire the behaviour. */
export const labeledButton = (
  label: string,
  className = "",
): HTMLButtonElement => {
  const button = createButton(className);
  button.textContent = label;
  return button;
};

export const buildCloseButton = (onClose: () => void): HTMLElement => {
  const button = labeledButton("Close", "close");
  button.addEventListener("click", onClose);
  return button;
};

/** The `.stepper` shell every row control shares: the row's own buttons, then
 *  the Remove button that runs `onRemove`. */
const buildStepperShell = (
  controls: HTMLElement[],
  onRemove: () => void,
): HTMLElement => {
  const wrap = document.createElement("span");
  wrap.className = "stepper";
  const remove = buildRemoveButton();
  remove.addEventListener("click", onRemove);
  wrap.append(...controls, remove);
  return wrap;
};

export const buildStepper = (
  quantity: number,
  onChange: (next: number) => void,
): HTMLElement => {
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
  return buildStepperShell([dec, value, inc], () => onChange(0));
};

/** The Remove button every cart row control shares. */
const buildRemoveButton = (): HTMLButtonElement => labeledButton("Remove");

/** A package row's only control: the whole bundle leaves the cart, and the
 *  package page owns every other count. */
export const buildRemovalOnly = (onRemove: () => void): HTMLElement =>
  buildStepperShell([], onRemove);

/** The cart widget's scoped CSS. Kept as one string so both delivery paths in
 *  {@link applyStyles} use exactly the same rules. */
const CART_STYLES = `
    .cart-button { position: fixed; right: 1rem; bottom: 1rem; padding: .75rem 1rem;
      border: 0; border-radius: 999px; background: #1a1a1a; color: #fff; cursor: pointer; }
    dialog { border: 0; border-radius: .5rem; box-sizing: border-box; padding: 1.25rem;
      width: min(calc(100vw - 2rem), 28rem); }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) auto;
      gap: .35rem .75rem; align-items: center; padding: .4rem 0; }
    .name { overflow-wrap: anywhere; }
    .stepper { grid-column: 1 / -1; display: flex; align-items: center; gap: .35rem; }
    .stepper button { min-height: 2rem; min-width: 2rem; margin: 0; padding: .3rem .5rem; }
    .stepper button:last-child { margin-left: auto; }
    .subtotal { font-weight: 700; }
    .caveat { font-size: .85em; opacity: .8; }
    .continue { display: block; width: 100%; margin-top: .75rem; padding: .6rem;
      border: 0; border-radius: .35rem; background: #1a1a1a; color: #fff; cursor: pointer; }
    .close { display: block; width: 100%; margin-top: .5rem; padding: .5rem; }
  `;

/** True when the browser can build a stylesheet in memory (Chrome 73+,
 *  Firefox 101+, Safari 16.4+). An in-memory sheet is pure CSSOM, so a host
 *  page's Content-Security-Policy never blocks it. An injected `<style>`
 *  element is subject to `style-src`, and a strict policy without
 *  `'unsafe-inline'` refuses it. `CSSStyleSheet` also exists as a plain
 *  interface on older Safari, where `new CSSStyleSheet()` throws. The probe
 *  asks for `replaceSync`, which only the constructable version carries. */
const canBuildStyleSheet = (): boolean =>
  typeof CSSStyleSheet === "function" &&
  typeof CSSStyleSheet.prototype.replaceSync === "function";

/** Attach the cart's scoped styles to its shadow root. Modern browsers adopt
 *  an in-memory stylesheet, so a strict host-page CSP never blocks it. Older
 *  browsers fall back to a `<style>` element. That element works everywhere
 *  except a host page that sets a strict `style-src`. */
export const applyStyles = (root: ShadowRoot): void => {
  if (canBuildStyleSheet()) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CART_STYLES);
    root.adoptedStyleSheets = [sheet];
    return;
  }
  const style = document.createElement("style");
  style.textContent = CART_STYLES;
  root.appendChild(style);
};
