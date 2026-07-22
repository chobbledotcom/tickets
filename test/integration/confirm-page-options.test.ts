import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";

test("passes optional identifiers and hidden fields to the confirm form", () => {
  const html = ConfirmPage({
    action: "/admin/example/confirm",
    active: "/admin/settings",
    buttonText: "Confirm",
    hiddenFields: { backup_filename: "backup.zip" },
    id: "example-confirm",
    label: "Name",
    name: "Example",
    session: { adminLevel: "owner" },
    title: "Confirm example",
  });

  expect(html).toContain('id="example-confirm"');
  expect(html).toContain('name="backup_filename"');
  expect(html).toContain('value="backup.zip"');
});
