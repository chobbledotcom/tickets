/**
 * The card a switch to booked-by-the-day serves while bookings without a day
 * remain. It names them and offers one date to move them all to. Saving the
 * surrounding edit form moves them and completes the switch. Leaving the page
 * changes nothing.
 */

import { t } from "#i18n";
import type { AssignCard } from "#routes/admin/listings-switch.ts";
import { formatDateLabel } from "#shared/date-labels.ts";

/** The date box the save reads the move's day from — the same field
 * `ASSIGN_UNDATED_FIELD` reads on the edit POST. */
const ASSIGN_FIELD = "assign_undated_to";

export const AssignUndatedDayCard = ({
  card,
}: {
  card: AssignCard;
}): JSX.Element => (
  <div class="notice listing-assign-day" role="alert">
    <h2>
      {t("listings_table.switch_daily_undated_heading", { count: card.count })}
    </h2>
    <p>{t("listings_table.switch_daily_undated_body")}</p>
    {card.noDates ? (
      <p>{t("listings_table.switch_daily_undated_no_dates")}</p>
    ) : card.noneFits ? (
      <p>
        {t("listings_table.switch_daily_undated_none_fits", {
          count: card.count,
        })}
      </p>
    ) : (
      <>
        <label for={ASSIGN_FIELD}>
          {t("listings_table.switch_daily_undated_pick")}
        </label>
        <select id={ASSIGN_FIELD} name={ASSIGN_FIELD}>
          <option selected={card.chosen === ""} value="">
            {t("listings_table.switch_daily_undated_pick_placeholder")}
          </option>
          {card.dates.map((date) => (
            <option selected={date === card.chosen} value={date}>
              {formatDateLabel(date)}
            </option>
          ))}
        </select>
      </>
    )}
  </div>
);
