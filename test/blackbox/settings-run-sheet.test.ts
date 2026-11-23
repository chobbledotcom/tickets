import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { App, Fields } from "#test/blackbox/driver.ts";
import {
  boxText,
  followed,
  loggedIn,
  pageAfter,
  redirectOf,
  type SettingsForm,
  send,
  testFormGuards,
} from "#test/blackbox/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const RUN_SHEET: SettingsForm = {
  action: "/admin/settings/logistics-run-sheet",
  field: "heading",
  page: "/admin/settings-advanced",
};

interface Templates {
  body: string;
  heading: string;
}

const NOTHING_KEPT: Templates = { body: "", heading: "" };
const KEPT: Templates = { body: "{{ day.date }}", heading: "{{ date }}" };
const UNREADABLE = "{% for x in items %}unclosed";

/** The owner who turned the logistics feature on. The page shows the two
 * boxes only then. */
const withLogistics = async (): Promise<App> => {
  const app = await loggedIn();
  redirectOf(
    await app.submit("/admin/features/logistics", { enabled: "true" }),
  );
  return app;
};

const templatesNow = async (app: App): Promise<Templates> => {
  const { html } = await app.get(RUN_SHEET.page);
  return { body: boxText(html, "body"), heading: boxText(html, "heading") };
};

/** The owner saves the boxes and reads the message on the next page. */
const save = (app: App, fields: Fields): Promise<string> =>
  pageAfter(app, RUN_SHEET, fields);

describeWithEnv(
  "the setting /admin/settings/logistics-run-sheet",
  { db: true },
  () => {
    test("the page hides the boxes until the logistics feature is on", async () => {
      const page = await (await loggedIn()).get(RUN_SHEET.page);
      expect(page.html).not.toContain(RUN_SHEET.action);
      expect(await templatesNow(await withLogistics())).toEqual(NOTHING_KEPT);
    });

    test("a save says so beside its form and keeps both templates, without the space around them", async () => {
      const app = await withLogistics();
      const written = {
        body: "{% for booking in day.bookings %}{{ booking.name }}{% endfor %}",
        heading: "{{ relative }} — {{ date_label }}",
      };
      const sent = await send(app, RUN_SHEET, {
        body: `  ${written.body}\n`,
        heading: ` ${written.heading}  `,
      });
      expect(redirectOf(sent).replace(/flash=[^&]*&/, "")).toBe(
        "/admin/settings-advanced?form=settings-logistics-run-sheet#settings-logistics-run-sheet",
      );
      expect((await followed(app, sent)).html).toContain(
        "Logistics run sheet template updated",
      );
      expect(await templatesNow(app)).toEqual(written);
    });

    /** Each box with a template that the site cannot read. */
    const REFUSED: [fields: Templates, box: string][] = [
      [{ body: "", heading: UNREADABLE }, "day heading"],
      [{ body: UNREADABLE, heading: "{{ date }}" }, "day body"],
      [{ body: UNREADABLE, heading: UNREADABLE }, "day body"],
    ];

    for (const [fields, box] of REFUSED) {
      test(`refuses heading "${fields.heading}" with body "${fields.body}", names the ${box}, and keeps nothing`, async () => {
        const app = await withLogistics();
        expect(await save(app, { ...fields })).toContain(
          `Invalid template syntax in the ${box}: `,
        );
        expect(await templatesNow(app)).toEqual(NOTHING_KEPT);
      });
    }

    test("empty boxes clear both templates", async () => {
      const app = await withLogistics();
      await save(app, { ...KEPT });
      expect(await templatesNow(app)).toEqual(KEPT);
      await save(app, { ...NOTHING_KEPT });
      expect(await templatesNow(app)).toEqual(NOTHING_KEPT);
    });

    test("a form sent with no boxes at all clears both templates", async () => {
      const app = await withLogistics();
      await save(app, { ...KEPT });
      await save(app, { body: null, heading: null });
      expect(await templatesNow(app)).toEqual(NOTHING_KEPT);
    });

    testFormGuards(
      RUN_SHEET,
      "{{ date }}",
      templatesNow,
      NOTHING_KEPT,
      withLogistics,
    );
  },
);
