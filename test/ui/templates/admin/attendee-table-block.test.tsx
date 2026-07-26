import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  AttendeeTableBlock,
  attendeeTableOptions,
} from "#templates/admin/attendee-table-block.tsx";
import { makeOpts } from "#test/ui/templates/attendee-table/shared.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("AttendeeTableBlock", () => {
  beforeAll(setupAdminPageTest);

  test("uses the attendee table's single scroll wrapper", () => {
    const html = String(
      <AttendeeTableBlock options={attendeeTableOptions(makeOpts())} />,
    );

    expect(html.match(/class="table-scroll"/g)).toHaveLength(1);
    expect(html).not.toContain("table-actions");
  });

  test("renders supplied actions after the table", () => {
    const html = String(
      <AttendeeTableBlock
        actions={<a href="/export">Export attendees</a>}
        options={attendeeTableOptions(makeOpts())}
      />,
    );

    expect(html).toContain(
      '</table></div><div class="table-actions"><a href="/export">Export attendees</a></div>',
    );
  });
});
