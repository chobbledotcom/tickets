import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { useManualCheckinPage } from "#test/ui/client/admin/manual-checkin/fixture.ts";

/** How a failure reaches the door: each fault the page can name has its
 * own words, and any other fault asks the door to reload. */
describe("scan failures the door reads", () => {
  const { fresh, pickedPage, stubScans } = useManualCheckinPage();

  test("names each failure the page can name, and asks for a reload otherwise", async () => {
    const cases: [Error, string][] = [
      [
        new DOMException("full", "QuotaExceededError"),
        "This was not saved because this device has no room left for this site. Turn offline mode off to free the space.",
      ],
      [
        new DOMException("blocked", "SecurityError"),
        "This browser blocks this site from saving data. Allow site data for this site, then reload this page.",
      ],
      [
        new Error("A fault the page cannot name"),
        "Something went wrong. Reload this page, then try again.",
      ],
    ];
    for (const [error, words] of cases) {
      const page = fresh({
        active: () => true,
        search: () => {
          throw error;
        },
      });
      page.input.value = "Ada";
      await page.submit();
      expect(page.status.textContent, error.name).toBe(words);
      expect(page.submitButton.disabled).toBe(false);
    }
  });

  test("a scan answer that names an unknown status fails loudly", async () => {
    const page = await pickedPage("11");
    stubScans([{ name: "Ada", status: "teleported" }]);
    await page.submit();

    // A status the page has no words for is a contract break, not a
    // generic answer: the door hears the page error.
    expect(page.status.textContent).toBe(
      "Something went wrong. Reload this page, then try again.",
    );
    expect(page.submitButton.disabled).toBe(false);
  });
});
