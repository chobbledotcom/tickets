/**
 * Taking a thing down from its own page: following the Actions tab, then the
 * link that takes it down, then typing its name to confirm.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { takeDownFromActions } from "#test/specs/support/form-controls.ts";

// jscpd:ignore-end

describe("taking a thing down from its own page", () => {
  /** A browser stand-in that remembers which links were followed and what
   * was sent, so the order of the journey can be seen. */
  const pageWithActions = () => {
    const followed: string[] = [];
    const sent: Record<string, string>[] = [];
    return {
      browser: {
        clickLink: (text: string) => {
          followed.push(text);
          return Promise.resolve();
        },
        currentHtml: '<input name="confirm_identifier" value="">',
        formBodyFor: () => '<input name="confirm_identifier" value="">',
        pageText: "Page deleted",
        submitForm: (values: Record<string, string>) => {
          sent.push(values);
          return Promise.resolve();
        },
      },
      followed,
      sent,
    };
  };

  /** One take-down, run through the helper the stories use. */
  const takeDown = (page: ReturnType<typeof pageWithActions>) =>
    takeDownFromActions(page.browser, "Directions", {
      deleteLink: "Delete page",
      submit: "Delete",
    });

  /** The page after one take-down has been run through it. */
  const afterTakingDown = async () => {
    const page = pageWithActions();
    await takeDown(page);
    return page;
  };

  test("follows the Actions tab, then the delete link", async () => {
    expect((await afterTakingDown()).followed).toEqual([
      t("entity.tab.actions"),
      "Delete page",
    ]);
  });

  test("types the name into the box the page asks for", async () => {
    expect((await afterTakingDown()).sent).toEqual([
      { confirm_identifier: "Directions" },
    ]);
  });

  test("hands back what the site said", async () => {
    expect(await takeDown(pageWithActions())).toBe("Page deleted");
  });
});
