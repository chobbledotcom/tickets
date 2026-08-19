/**
 * The small pill/label `<span>` used across admin and public pages. Every badge
 * is `<span class="{variant class}">{children}</span>`; the variant selects the
 * class, so the class strings live in one exhaustive table here instead of
 * being hand-typed (and re-detected as clones) at each call site.
 *
 * `statusBadge` is the common boolean specialisation — an "ok" pill when a flag
 * is set, a "missing" one when it isn't — which several pages used to spell out
 * as their own two-arm component.
 */

import type { Child } from "#jsx/jsx-runtime.ts";

/** The badge styles in use; each maps to the exact class string emitted. */
export type BadgeVariant = "default" | "ok" | "missing" | "alert" | "danger";

const BADGE_CLASS: Record<BadgeVariant, string> = {
  alert: "badge-alert",
  danger: "badge danger",
  default: "badge",
  missing: "badge-missing",
  ok: "badge-ok",
};

export const Badge = ({
  variant = "default",
  children,
}: {
  variant?: BadgeVariant;
  children: Child;
}): JSX.Element => <span class={BADGE_CLASS[variant]}>{children}</span>;

/** Boolean pill: an "ok" badge with `onLabel` when the flag is set, a "missing"
 *  badge with `offLabel` when it isn't. */
export const statusBadge = (
  on: boolean,
  onLabel: Child,
  offLabel: Child,
): JSX.Element => (
  <Badge variant={on ? "ok" : "missing"}>{on ? onLabel : offLabel}</Badge>
);
