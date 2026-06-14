/**
 * Shared action components: button-styled links, guide links, and inline
 * icons. These standardise the look of primary actions ("Add Listing",
 * "Invite User", "Pay Now") and help links ("…guide") across the app.
 *
 * Icons are served from a static SVG sprite (`/icons.svg`) and referenced via
 * `<use>`, so nothing is bundled into the JS payload.
 */

import type { Child, SafeHtml } from "#jsx/jsx-runtime.ts";
import { ICONS_PATH } from "#shared/asset-paths.ts";

/** Icon ids available in the sprite (src/ui/static/icons.svg) */
export type IconName =
  | "plus"
  | "book-open"
  | "user-plus"
  | "arrow-right"
  | "credit-card"
  | "hammer"
  | "rotate-ccw";

/** Visual variants for a button-styled link */
export type BtnVariant = "primary" | "outline" | "secondary";

/** Inline SVG icon sized to the current font (1em), tinted with currentColor */
export const Icon = ({ name }: { name: IconName }): SafeHtml => (
  <svg aria-hidden="true" class="icon" focusable="false">
    <use href={`${ICONS_PATH}#${name}`} />
  </svg>
);

/**
 * A link styled as a button. Use for primary page actions. Pass an optional
 * `icon` and `variant` ("outline"/"secondary").
 */
export const ActionButton = ({
  href,
  icon,
  variant = "primary",
  children,
}: {
  href: string;
  icon?: IconName;
  variant?: BtnVariant;
  children?: Child;
}): SafeHtml => (
  <a class={variant === "primary" ? "btn" : `btn ${variant}`} href={href}>
    {icon ? <Icon name={icon} /> : null}
    <span>{children}</span>
  </a>
);

/**
 * A consistent, understated link to a help/guide section. Renders a book icon
 * followed by the label in muted text.
 */
export const GuideLink = ({
  href,
  children,
}: {
  href: string;
  children?: Child;
}): SafeHtml => (
  <a class="guide-link" href={href}>
    <Icon name="book-open" />
    <span>{children}</span>
  </a>
);
