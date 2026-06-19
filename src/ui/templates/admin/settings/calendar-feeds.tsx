/** Calendar feed settings form for advanced settings. */

import { t } from "#i18n";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const CalendarFeedsForm = (s: AdvancedSettingsPageState): string =>
  String(
    <SettingsSection
      action="/admin/settings/calendar-feeds"
      description={
        <p>
          {t("settings.advanced.calendar_feeds_hint")}{" "}
          <code>/caldav/events.ics</code>
        </p>
      }
      id="settings-calendar-feeds"
      submitLabel={t("settings.advanced.save_calendar_feeds")}
      title={t("settings.advanced.calendar_feeds")}
    >
      <label>
        <input
          checked={s.calendarFeedsEnabled}
          name="calendar_feeds_enabled"
          type="checkbox"
          value="true"
        />{" "}
        {t("settings.advanced.calendar_feeds_enabled")}
      </label>
      <label for="calendar_feeds_group_by">
        {t("settings.advanced.calendar_feeds_group_by")}
      </label>
      <select id="calendar_feeds_group_by" name="calendar_feeds_group_by">
        <option
          selected={s.calendarFeedsGroupBy === "attendees"}
          value="attendees"
        >
          {t("settings.advanced.calendar_feeds_group_by_attendees")}
        </option>
        <option
          selected={s.calendarFeedsGroupBy === "listings"}
          value="listings"
        >
          {t("settings.advanced.calendar_feeds_group_by_listings")}
        </option>
      </select>
    </SettingsSection>,
  );
