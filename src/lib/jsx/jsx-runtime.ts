/**
 * Custom JSX runtime for server-side HTML string generation
 * No React required - just compiles JSX to string concatenation
 */

/**
 * Wrapper for HTML that should not be escaped.
 * Has toString() so it works seamlessly in string contexts.
 */
export class SafeHtml {
  constructor(public html: string) {}
  toString(): string {
    return this.html;
  }
}

/** Child types that can be rendered */
export type Child =
  | string
  | number
  | boolean
  | null
  | undefined
  | SafeHtml
  | Child[];

/** HTML attribute types */
interface HtmlAttributes {
  children?: Child;
  class?: string;
  style?: string;
  // Common HTML attributes
  id?: string;
  name?: string;
  type?: string;
  value?: string | number;
  href?: string;
  src?: string;
  alt?: string;
  title?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  checked?: boolean;
  readonly?: boolean;
  min?: number | string;
  max?: number | string;
  pattern?: string;
  rows?: string | number;
  cols?: string | number;
  for?: string;
  method?: string;
  action?: string;
  target?: string;
  rel?: string;
  colspan?: string | number;
  rowspan?: string | number;
  lang?: string;
  charset?: string;
  content?: string;
  // Allow any other attributes
  [key: string]: Child | string | number | boolean | null | undefined;
}

/** JSX type declarations */
declare global {
  namespace JSX {
    type Element = SafeHtml;
    interface IntrinsicElements {
      [elemName: string]: HtmlAttributes;
    }
    interface ElementChildrenAttribute {
      children: Child;
    }
  }
}

const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Void elements that should not have closing tags */
const VOID_ELEMENTS: Record<string, true> = {
  area: true,
  base: true,
  br: true,
  col: true,
  embed: true,
  hr: true,
  img: true,
  input: true,
  link: true,
  meta: true,
  param: true,
  source: true,
  track: true,
  wbr: true,
};

const isSafeHtml = (value: unknown): value is SafeHtml =>
  value instanceof SafeHtml;

type Props = Record<string, unknown> & { children?: Child };
type Component = (props: Props) => SafeHtml | string;

const renderChild = (child: Child): string => {
  if (child === null || child === undefined || child === false) return "";
  if (child === true) return "";
  if (isSafeHtml(child)) return child.html;
  if (Array.isArray(child)) return child.map(renderChild).join("");
  return escapeHtml(String(child));
};

const renderAttr = (key: string, value: unknown): string => {
  if (value === null || value === undefined || value === false) return "";
  if (value === true) return ` ${key}`;
  return ` ${key}="${escapeHtml(String(value))}"`;
};

/**
 * JSX factory function - transforms JSX elements to HTML strings
 */
export const jsx = (tag: string | Component, props: Props | null): SafeHtml => {
  const { children, ...attrs } = props ?? {};

  // Component function - call it with props
  if (typeof tag === "function") {
    const result = tag({ ...attrs, children });
    return isSafeHtml(result) ? result : new SafeHtml(result);
  }

  // Build attributes string
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => renderAttr(k, v))
    .join("");

  // Void elements (self-closing)
  if (VOID_ELEMENTS[tag]) {
    return new SafeHtml(`<${tag}${attrStr}>`);
  }

  // Regular elements
  const childStr = renderChild(children);
  return new SafeHtml(`<${tag}${attrStr}>${childStr}</${tag}>`);
};

// JSX runtime exports (used by TypeScript's JSX transform)
export { jsx as jsxs, jsx as jsxDEV };

/**
 * Fragment - just renders children without wrapper
 */
export const Fragment = ({ children }: Props): SafeHtml =>
  new SafeHtml(renderChild(children));

/**
 * Raw HTML insertion (use sparingly, bypasses escaping)
 * For pre-escaped content like rendered form fields
 */
export const Raw = ({ html }: { html: string }): SafeHtml => new SafeHtml(html);
