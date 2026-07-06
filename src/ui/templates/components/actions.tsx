/**
 * Shared action components: button-styled links, guide links, and inline
 * icons. These standardise the look of primary actions ("Add Listing",
 * "Invite User", "Pay Now") and help links ("…guide") across the app.
 *
 * Icons are served from a static SVG sprite (`/icons.svg`) and referenced via
 * `<use>`, so nothing is bundled into the JS payload.
 */

import { t } from "#i18n";
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
  | "shopping-cart"
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

/** The standard "Save changes" submit button used on admin edit pages. */
export const SaveChangesButton = (): SafeHtml => (
  <SubmitButton icon="save">{t("common.save_changes")}</SubmitButton>
);

/** The "Save" submit button (shorter label than SaveChangesButton). */
export const SaveButton = (): SafeHtml => (
  <SubmitButton icon="save">{t("common.save")}</SubmitButton>
);

/**
 * The "Delete" affordance shown at the bottom of an entity's edit page. Renders
 * a heading plus a secondary, button-styled link to the delete-confirmation
 * page, so every edit page exposes deletion the same way (and the destructive
 * action always goes through the typed-name confirmation round trip rather than
 * sitting inline in a list table). Pass the confirmation-page `href`, the
 * section `heading`, and the link label as children.
 */
export const DeleteSection = ({
  href,
  heading,
  children,
}: {
  href: string;
  heading: string;
  children?: Child;
}): SafeHtml => (
  <>
    <h2>{heading}</h2>
    <p class="prose">
      <ActionButton href={href} icon="trash-2" variant="secondary">
        {children}
      </ActionButton>
    </p>
  </>
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
 * Shared prop shape for an icon-prefixed link: an `href` plus an optional label
 * rendered as the link's body. Used by {@link BackButton} (arrow-left icon)
 * and {@link GuideLink} (book-open icon) — both share the same name/children
 * shape and only differ in the rendered icon and link class. */
type IconLinkProps = {
  href: string;
  children?: Child;
};

/**
 * Build an icon link renderer: takes the link class and icon name, returns a
 * component taking {@link IconLinkProps}. {@link BackButton} and {@link GuideLink}
 * are specialisations of this — they share the `<a class=... href=...><Icon/><span>{children}</span></a>`
 * shape; only the class and icon differ.
 */
const iconLink =
  (
    linkClass: string,
    iconName: IconName,
  ): (({ href, children }: IconLinkProps) => SafeHtml) =>
  ({ href, children }: IconLinkProps): SafeHtml => (
    <a class={linkClass} href={href}>
      <Icon name={iconName} />
      <span>{children}</span>
    </a>
  );

/**
 * A compact, button-styled "Back to …" navigation link. Renders a leading
 * arrow-left icon followed by the label (e.g. "Back to attendee"). Pair the
 * `href` with the destination and pass the label as children — omit the arrow
 * glyph, the icon supplies it.
 */
export const BackButton = iconLink("btn small", "arrow-left");

/**
 * A consistent, understated link to a help/guide section. Renders a book icon
 * followed by the label in muted text.
 */
export const GuideLink = iconLink("guide-link", "book-open");

/**
 * A page's guide link, placed at the very bottom of the body. Every admin page
 * that maps to a guide section renders one of these as its last element, so the
 * "…guide" affordance sits consistently in the same spot instead of competing
 * with the page's primary actions at the top.
 */
export const GuideFooter = ({
  href,
  children,
}: {
  href: string;
  children?: Child;
}): SafeHtml => (
  <p class="guide-footer">
    <GuideLink href={href}>{children}</GuideLink>
  </p>
);
