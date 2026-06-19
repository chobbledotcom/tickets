/** Calendar feed settings form for the settings page. */

import { t } from "#i18n";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const CalendarFeedsForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/calendar-feeds"
    description={
      <p>
        {t("settings.calendar_feeds_hint")} <code>/caldav/events.ics</code>
      </p>
    }
    submitLabel={t("settings.save_calendar_feeds")}
    title={t("settings.calendar_feeds")}
  >
    <label>
      <input
        checked={s.calendarFeedsEnabled}
        name="calendar_feeds_enabled"
        type="checkbox"
        value="true"
      />{" "}
      {t("settings.calendar_feeds_enabled")}
    </label>
    <label for="calendar_feeds_group_by">
      {t("settings.calendar_feeds_group_by")}
    </label>
    <select id="calendar_feeds_group_by" name="calendar_feeds_group_by">
      <option
        selected={s.calendarFeedsGroupBy === "attendees"}
        value="attendees"
      >
        {t("settings.calendar_feeds_group_by_attendees")}
      </option>
      <option selected={s.calendarFeedsGroupBy === "listings"} value="listings">
        {t("settings.calendar_feeds_group_by_listings")}
      </option>
    </select>
  </SettingsSection>
);
