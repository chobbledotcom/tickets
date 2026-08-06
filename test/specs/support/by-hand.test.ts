// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  csvDateColumn,
  csvEvidencePage,
} from "#test/specs/support/evidence.ts";

// jscpd:ignore-end

const previewHtml = (path: string): string =>
  decodeURIComponent(path.slice("data:text/html,".length));

describe("csvDateColumn", () => {
  test("keeps the exported dates without attendee personal data", () => {
    expect(
      csvDateColumn(
        "Date,Name,Email,Phone\n2026-08-16 to 2026-08-17,Jane Doe,jane@example.com,07123456789",
      ),
    ).toBe("Date\n2026-08-16 to 2026-08-17");
  });

  test("renders escaped text in the data-page preview", () => {
    const path = csvEvidencePage("Retreat & <stay>", "Date & time");

    expect(path.startsWith("data:text/html,")).toBe(true);
    expect(previewHtml(path)).toContain(
      "Retreat &amp; &lt;stay&gt; attendee CSV",
    );
    expect(previewHtml(path)).toContain("Date &amp; time");
  });
});
