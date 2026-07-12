/** Calendar feed settings form for the settings page. */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { SettingsCheckbox } from "#templates/admin/settings/theme.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SelectField } from "#templates/components/select-field.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
/* jscpd:ignore-end */

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
    <SettingsCheckbox
      checked={s.calendarFeedsEnabled}
      label={t("settings.calendar_feeds_enabled")}
      name="calendar_feeds_enabled"
    />
    <label for="calendar_feeds_group_by">
      {t("settings.calendar_feeds_group_by")}
    </label>
    <SelectField
      id="calendar_feeds_group_by"
      name="calendar_feeds_group_by"
      options={[
        {
          label: t("settings.calendar_feeds_group_by_attendees"),
          value: "attendees",
        },
        {
          label: t("settings.calendar_feeds_group_by_listings"),
          value: "listings",
        },
      ]}
      value={s.calendarFeedsGroupBy}
    />
  </SettingsSection>
);
