/**
 * Admin guide — Operations sections.
 */

import { t } from "#i18n";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  custom,
  faq,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";
import { listingTable } from "#templates/admin/listing-table.tsx";
import { attendeeTable } from "#templates/attendee-table.tsx";
import { renderColumnReference } from "#templates/components/table.tsx";

/** The "Default order: `<code>`" line a table-columns FAQ answer opens with. */
const defaultOrderParagraph = (template: string): JSX.Element => (
  <p>
    {t("guide.table_columns.default_order")} <code>{template}</code>
  </p>
);

export const operationsSections = (): GuideSection[] => [
  {
    entries: [
      faq("what_is_servicing"),
      faq("create_service_event"),
      faq("record_servicing_costs"),
      faq("servicing_and_profit"),
    ],
    id: "servicing",
    titleKey: "servicing",
  },
  {
    entries: [
      faq("what_is_logistics"),
      faq("logistics_agents"),
      faq("enable_logistics_on_listing"),
      faq("delivery_run_sheet"),
    ],
    id: "logistics",
    titleKey: "logistics",
  },
  {
    entries: [
      faq("what_is_image_library"),
      faq("add_image_to_library"),
      faq("link_image_to_listing"),
      faq("delete_library_image"),
    ],
    id: "images",
    titleKey: "images",
  },
  {
    entries: [
      faq("what_are_attendee_statuses"),
      faq("status_flags"),
      faq("reservation_amount"),
      faq("assign_change_status"),
    ],
    id: "attendee-statuses",
    titleKey: "attendee_statuses",
  },
  {
    entries: [
      faq("what_is_attendees_list"),
      faq("export_attendees_csv"),
      faq("where_are_attendee_actions"),
    ],
    id: "attendees",
    titleKey: "attendees",
  },
  {
    entries: [
      faq("what_is_the_backup_feature"),
      faq("how_do_i_create_a_backup"),
      faq("how_do_i_restore_from_a_backup"),
      faq("are_old_backups_deleted_automatically"),
      faq("what_is_the_encryption_key_shown_on"),
      faq("do_backups_require_any_special_configuration"),
    ],
    id: "backups",
    titleKey: "backups",
  },
  {
    entries: [faq("why_does_my_site_say_it_s")],
    id: "read-only-mode",
    titleKey: "read_only_mode",
  },
  {
    entries: [
      faq("how_do_i_check_for_updates"),
      faq("what_does_the_version_number_mean"),
      faq("how_do_i_install_an_update"),
      faq("where_can_i_read_the_release_notes"),
    ],
    id: "software-updates",
    titleKey: "software_updates",
  },
  {
    entries: [
      faq("customise_system"),
      faq("customise_for_me"),
      faq("custom_css"),
      faq("hosting_and_images"),
    ],
    titleKey: "customising_your_site",
  },
  {
    entries: [
      faq("customise_table_columns"),
      custom(
        "listing_table_columns",
        <>
          {defaultOrderParagraph(listingTable.layout.defaultTemplate)}
          {renderColumnReference(listingTable)}
        </>,
      ),
      custom(
        "attendee_table_columns",
        <>
          {defaultOrderParagraph(attendeeTable.layout.defaultTemplate)}
          <Raw html={t("guide.table_columns.attendee_hidden")} />
          {renderColumnReference(attendeeTable)}
        </>,
      ),
      faq("column_format_filters"),
    ],
    id: "column-order",
    titleKey: "column_order",
  },
];
