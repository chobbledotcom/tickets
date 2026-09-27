/** The gate a record page runs before its handler: the audience it serves is
 * the page's own declaration, and an explicit empty audience closes the page
 * to everyone. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { recordPageGuardFor } from "#routes/auth.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  createTestEditorSession,
  createTestScannerSession,
} from "#test-utils/session.ts";

const LISTING_PATH = "/admin/listing/1";

describeWithEnv("recordPageGuardFor", { db: true }, () => {
  test("admits a role the record's folded floor admits, and refuses the rest", async () => {
    // The listing page's floor is its content audience: an editor passes the
    // gate (and meets the missing record's 404), a scanner never gets that
    // far.
    const editor = await createTestEditorSession();
    const scanner = await createTestScannerSession();

    expect(
      (await awaitTestRequest(LISTING_PATH, { cookie: editor.cookie })).status,
      "editor",
    ).toBe(404);
    expect(
      (await awaitTestRequest(LISTING_PATH, { cookie: scanner.cookie })).status,
      "scanner",
    ).toBe(403);
  });

  test("an explicitly empty audience closes the page to everyone", async () => {
    const guard = recordPageGuardFor(
      {
        area: "listings",
        audience: [],
        id: "listing",
        intent: "view",
        pattern: LISTING_PATH,
      },
      [],
    );

    const statusFor = async (cookie: string): Promise<number> =>
      (
        await guard(
          new Request(`http://localhost${LISTING_PATH}`, {
            headers: { cookie },
          }),
          () => new Response("served"),
        )
      ).status;

    const editor = await createTestEditorSession();
    const scanner = await createTestScannerSession();
    expect(await statusFor(editor.cookie), "editor").toBe(403);
    expect(await statusFor(scanner.cookie), "scanner").toBe(403);
  });
});
