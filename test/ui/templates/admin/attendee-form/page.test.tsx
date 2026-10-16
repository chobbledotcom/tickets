/** The attendee-form pages' shells: the spec render around the create form
 *  and the prose-headed attendees page. */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  AttendeesPage,
  attendeeFormPage,
} from "#templates/admin/attendee-form.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { data } from "./fixtures.ts";

describe("attendee form page shells", () => {
  beforeAll(setupAdminPageTest);

  test("renders the create page shell around the form panel", () => {
    const html = attendeeFormPage(data(), OWNER_SESSION);

    expect(html).toContain('data-page-family="admin"');
    expect(html).toContain(`<title>${t("attendee_form.title_create")}</title>`);
    expect(html).toContain('id="attendee-form"');
    expect(html).toContain('<form action="/admin/attendees/new"');
    expect(html).toContain("<h1>Add new attendee</h1>");
  });

  test("renders the attendees page shell with its prose heading", () => {
    const html = AttendeesPage({
      active: "/admin/attendees",
      children: <p>The body</p>,
      prose: <p>The intro</p>,
      session: OWNER_SESSION,
      title: "Attendees",
    });

    expect(html).toContain('data-page-family="admin"');
    expect(html).toContain('<a class="active" href="/admin/attendees">');
    expect(html).toContain("<h1>Attendees</h1>");
    expect(html).toContain("<p>The intro</p>");
    expect(html).toContain("<p>The body</p>");
    expect(html.indexOf("<h1>Attendees</h1>")).toBeLessThan(
      html.indexOf("<p>The body</p>"),
    );
  });
});
