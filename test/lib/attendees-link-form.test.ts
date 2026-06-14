import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createLinkEventForm } from "#routes/admin/attendees-link-form.ts";

describe("createLinkEventForm", () => {
  test("filters out inactive events from the options", () => {
    const form = createLinkEventForm([
      { active: true, id: 1, name: "Active A" },
      { active: false, id: 2, name: "Inactive B" },
      { active: true, id: 3, name: "Active C" },
    ]);
    const html = form.render();
    expect(html).toContain("Active A");
    expect(html).toContain("Active C");
    expect(html).not.toContain("Inactive B");
  });
});
