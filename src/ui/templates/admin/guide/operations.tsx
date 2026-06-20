/**
 * Admin guide — Operations sections.
 */

import { t } from "#i18n";
import { buildDefaultTemplate } from "#shared/column-order.ts";
import {
  ATTENDEE_DEFAULT_ORDER,
  ATTENDEE_TABLE_COLUMNS,
} from "#shared/columns/attendee-columns.ts";
import {
  LISTING_DEFAULT_ORDER,
  LISTING_TABLE_COLUMNS,
} from "#shared/columns/listing-columns.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  columnReferenceTable,
  custom,
  faq,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";

export const operationsSections = (): GuideSection[] => [
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
    title: "Backups",
  },
  {
    entries: [faq("why_does_my_site_say_it_s")],
    id: "read-only-mode",
    title: "Read-only Mode",
  },
  {
    entries: [
      faq("how_do_i_check_for_updates"),
      faq("what_does_the_version_number_mean"),
      faq("how_do_i_install_an_update"),
      faq("where_can_i_read_the_release_notes"),
    ],
    title: "Software Updates",
  },
  {
    entries: [
      faq("customise_system"),
      faq("customise_for_me"),
      faq("hosting_and_images"),
    ],
    title: t("guide.sections.customising_your_site"),
  },
  {
    entries: [
      custom(
        "How do I customise which columns appear in tables?",
        <>
          <p>
            Go to <strong>Advanced Settings</strong> and find the{" "}
            <strong>Listing Table Columns</strong> or{" "}
            <strong>Attendee Table Columns</strong> section. Enter a
            comma-separated list of Liquid-style tags to control which columns
            appear and in what order.
          </p>
          <p>
            For example, to show only the name and status on the listings table:
          </p>
          <pre>
            <code>{"{{name}}, {{status}}"}</code>
          </pre>
          <p>
            Leave the field empty or clear it to restore the default column
            order.
          </p>
        </>,
      ),
      custom(
        "What listing table columns are available?",
        <>
          <p>
            Default order:{" "}
            <code>{buildDefaultTemplate(LISTING_DEFAULT_ORDER)}</code>
          </p>
          <Raw html={columnReferenceTable(LISTING_TABLE_COLUMNS)} />
        </>,
      ),
      custom(
        "What attendee table columns are available?",
        <>
          <p>
            Default order:{" "}
            <code>{buildDefaultTemplate(ATTENDEE_DEFAULT_ORDER)}</code>
          </p>
          <p>
            Columns referencing absent data (e.g. <code>{"{{email}}"}</code>{" "}
            when no attendees have an email) are hidden automatically even when
            included in the template.
          </p>
          <Raw html={columnReferenceTable(ATTENDEE_TABLE_COLUMNS)} />
        </>,
      ),
      custom(
        "Can I use custom date or currency formatting?",
        <>
          <p>
            Yes. Date and price columns support Liquid filters. Add a pipe (
            <code>|</code>) after the column name followed by the filter:
          </p>
          <pre>
            <code>
              {'{{created | date: "%B %d, %Y"}}'}
              {"\n"}
              {'{{date | date: "%A %e %b"}}'}
              {"\n"}
              {"{{price | currency}}"}
            </code>
          </pre>
          <p>
            The <code>date</code> filter uses{" "}
            <a href="https://strftime.net/">strftime format codes</a>. Common
            codes:
          </p>
          <ul>
            <li>
              <code>%Y</code> full year, <code>%y</code> 2-digit year
            </li>
            <li>
              <code>%B</code> full month name, <code>%b</code> abbreviated
            </li>
            <li>
              <code>%d</code> zero-padded day, <code>%e</code> day without
              padding
            </li>
            <li>
              <code>%A</code> full weekday, <code>%a</code> abbreviated
            </li>
            <li>
              <code>%H</code> hour (24h), <code>%I</code> hour (12h),{" "}
              <code>%M</code> minutes
            </li>
          </ul>
          <p>
            The <code>currency</code> filter formats a number as your configured
            currency (e.g. <code>2500</code> &rarr; &pound;25.00).
          </p>
          <p>
            Columns without a <code>rawValue</code> (like name or email) ignore
            filters &mdash; they always render their default content.
          </p>
        </>,
      ),
    ],
    id: "column-order",
    title: "Column Order",
  },
];
