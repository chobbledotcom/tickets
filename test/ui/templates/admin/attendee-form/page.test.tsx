/** The attendee-form pages' whole-page equality: both shells render the exact
 *  markup the parent build rendered for the same inputs. */

import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  AttendeesPage,
  attendeeFormPage,
} from "#templates/admin/attendee-form.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { assertPageMatchesSnapshot } from "#test-utils/page-snapshot.ts";
import { data } from "./fixtures.ts";

describe("attendee form page shells", () => {
  beforeAll(setupAdminPageTest);

  test("renders the create page identically to the parent build", () => {
    const html = attendeeFormPage(data(), OWNER_SESSION);

    assertPageMatchesSnapshot(
      new URL("./attendee-create.snapshot.html", import.meta.url),
      html,
    );
  });

  test("renders the attendees page identically to the parent build", () => {
    const html = AttendeesPage({
      active: "/admin/attendees",
      children: <p>The body</p>,
      prose: <p>The intro</p>,
      session: OWNER_SESSION,
      title: "Attendees",
    });

    assertPageMatchesSnapshot(
      new URL("./attendee-page.snapshot.html", import.meta.url),
      html,
    );
  });
});
