/**
 * The one shared capacity meter: "count / max — n remain", plus the single
 * place the 90% warning threshold and the seats-left maths live.
 */

import { t } from "#i18n";

/** How full a count is against its cap: seats left, whether the count is
 * close to the cap (90% or more), and whether it has reached the cap. A cap
 * of zero means "no cap", so nothing is ever near or over it. */
export const capacityLevel = (
  count: number,
  max: number,
): { remaining: number; nearLimit: boolean; overLimit: boolean } => ({
  nearLimit: max > 0 && count >= max * 0.9,
  overLimit: max > 0 && count >= max,
  remaining: max - count,
});

/** The meter's text: "12 / 20 — 8 remain". Pass `remaining` when the shown
 * seats-left figure differs from the raw maths (group rows floor it at 0). */
export const capacityMeterText = (
  count: number,
  max: number,
  remaining: number = capacityLevel(count, max).remaining,
): string =>
  `${count} / ${max} ${t("capacity.mdash")} ${remaining} ${t("capacity.remain")}`;

/** What every meter render needs: the figures plus the caller's warning flag. */
export type CapacityMeterProps = {
  count: number;
  max: number;
  /** Turns the meter red — callers pass the level flag their table warns on. */
  danger: boolean;
  /** Overrides the shown seats-left figure (group rows floor it at 0). */
  remaining?: number | undefined;
};

/** Meter for string-built tables: plain text normally, wrapped in a danger
 * span when the caller's warning flag is on (these tables add no span at all
 * when the level is safe). */
export const capacityMeterHtml = ({
  count,
  max,
  danger,
  remaining,
}: CapacityMeterProps): string => {
  const text = capacityMeterText(count, max, remaining);
  return danger ? `<span class="danger-text">${text}</span>` : text;
};

/** Meter for JSX tables: a span that turns red when the warning flag is on. */
export const CapacityMeter = ({
  count,
  max,
  danger,
  remaining,
}: CapacityMeterProps): JSX.Element => (
  <span class={danger ? "danger-text" : ""}>
    {capacityMeterText(count, max, remaining)}
  </span>
);

/** The group-attendees meter: warns from 90% full, and never shows fewer
 * than zero seats left. Shared by the group page and the listing page's
 * group row so the two can't drift. */
export const GroupCapacityMeter = ({
  count,
  max,
}: {
  count: number;
  max: number;
}): JSX.Element => {
  const level = capacityLevel(count, max);
  return (
    <CapacityMeter
      count={count}
      danger={level.nearLimit}
      max={max}
      remaining={Math.max(0, level.remaining)}
    />
  );
};
