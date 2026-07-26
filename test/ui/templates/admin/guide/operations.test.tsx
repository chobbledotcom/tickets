import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import type { GuideSection } from "#templates/admin/guide/components.tsx";
import { renderGuideSections } from "#templates/admin/guide/components.tsx";
import { operationsSections } from "#templates/admin/guide/operations.tsx";
import { listingTable } from "#templates/admin/listing-table.tsx";
import { attendeeTable } from "#templates/attendee-table/columns.tsx";

const sections = operationsSections();

const columnOrderSection = (): GuideSection => {
  const section = sections.find(({ titleKey }) => titleKey === "column_order");
  if (section === undefined) throw new Error("Column order guide is missing");
  return section;
};

describe("operations guide schema", () => {
  test("keeps every operations section in its intended order", () => {
    expect(sections.map(({ id, titleKey }) => ({ id, titleKey }))).toEqual([
      { id: "servicing", titleKey: "servicing" },
      { id: "logistics", titleKey: "logistics" },
      { id: "images", titleKey: "images" },
      { id: "attendee-statuses", titleKey: "attendee_statuses" },
      { id: "attendees", titleKey: "attendees" },
      { id: "backups", titleKey: "backups" },
      { id: "read-only-mode", titleKey: "read_only_mode" },
      { id: "software-updates", titleKey: "software_updates" },
      { id: undefined, titleKey: "customising_your_site" },
      { id: "column-order", titleKey: "column_order" },
    ]);
  });

  test("keeps the two table references as custom entries between the FAQs", () => {
    expect(
      columnOrderSection().entries.map((entry) =>
        "faq" in entry
          ? { id: entry.faq, kind: "faq" }
          : { id: entry.custom, kind: "custom" },
      ),
    ).toEqual([
      { id: "customise_table_columns", kind: "faq" },
      { id: "listing_table_columns", kind: "custom" },
      { id: "attendee_table_columns", kind: "custom" },
      { id: "column_format_filters", kind: "faq" },
    ]);
  });

  test("renders each custom table answer with its own default and notes", () => {
    const html = String(renderGuideSections([columnOrderSection()]));
    const listingStart = html.indexOf(t("guide.q.listing_table_columns"));
    const attendeeStart = html.indexOf(t("guide.q.attendee_table_columns"));
    const filtersStart = html.indexOf(t("guide.q.column_format_filters"));

    expect(listingStart).toBeGreaterThan(-1);
    expect(attendeeStart).toBeGreaterThan(listingStart);
    expect(filtersStart).toBeGreaterThan(attendeeStart);

    const listingAnswer = html.slice(listingStart, attendeeStart);
    const attendeeAnswer = html.slice(attendeeStart, filtersStart);
    expect(listingAnswer).toContain(
      `<code>${listingTable.layout.defaultTemplate}</code>`,
    );
    expect(attendeeAnswer).toContain(
      `<code>${attendeeTable.layout.defaultTemplate}</code>`,
    );
    expect(listingAnswer).not.toContain(
      t("guide.table_columns.attendee_hidden"),
    );
    expect(attendeeAnswer).toContain(t("guide.table_columns.attendee_hidden"));
    expect(listingAnswer).toContain("<code>{{name}}</code>");
    expect(attendeeAnswer).toContain("<code>{{email}}</code>");
  });
});
