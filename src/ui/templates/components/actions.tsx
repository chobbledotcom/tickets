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

/**
 * Icon ids available in the sprite (src/ui/static/icons.svg).
 * Names match their source icons in Lucide (https://lucide.dev).
 */
export type IconName =
  | "plus"
  | "book-open"
  | "user-plus"
  | "arrow-right"
  | "arrow-left"
  | "credit-card"
  | "hammer"
  | "rotate-ccw"
  | "save"
  | "check"
  | "search"
  | "trash-2"
  | "log-in"
  | "log-out"
  | "x";

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
 * A form submit button with a leading icon. Mirrors {@link ActionButton} for
 * the primary action of a form (e.g. "Save", "Create Listing"). Pass `class`
 * to layer on the existing button modifiers (`secondary`, `danger`, …) and an
 * optional `id` for buttons targeted by client scripts.
 */
export const SubmitButton = ({
  icon,
  class: className,
  id,
  children,
}: {
  icon: IconName;
  class?: string;
  id?: string;
  children?: Child;
}): SafeHtml => (
  <button class={className} id={id} type="submit">
    <Icon name={icon} />
    <span>{children}</span>
  </button>
);

/**
 * A link that can be disabled. When enabled, renders an `<a>` pointing at
 * `href`. When `disabled`, renders a non-interactive `<span>` carrying
 * `.btn--disabled` (greyed out, not clickable) so the affordance stays visible
 * but inert — `title` should explain why. Pass `class` to layer on button
 * styling (e.g. "btn") or omit it for a plain link.
 */
export const MaybeButtonLink = ({
  href,
  disabled = false,
  class: className,
  title,
  children,
}: {
  href: string;
  disabled?: boolean;
  class?: string;
  title?: string;
  children?: Child;
}): SafeHtml =>
  disabled ? (
    <span
      class={[className, "btn--disabled"].filter(Boolean).join(" ")}
      title={title}
    >
      {children}
    </span>
  ) : (
    <a class={className} href={href} title={title}>
      {children}
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
