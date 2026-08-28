import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type CatalogCopy,
  findLabelIssues,
} from "#scripts/check-e2e-labels/rules.ts";

/** A catalog from bare values (and keys when a case exercises them). */
const catalog = (
  values: string[],
  keys: string[] = [],
  groupOf: Record<string, string> = {},
): CatalogCopy => ({
  groupOf: new Map(Object.entries(groupOf)),
  keys: new Set(keys),
  values,
});

describe("e2e label rules", () => {
  test("accepts literals the catalog renders, in every scanned call", () => {
    const source = [
      `await session.clickButton("Save Payment Provider");`,
      `await ownerOf(world).clickLink("Edit");`,
      `requirePageText(owner, "was automatically refunded", "a", "m");`,
      `requirePageText(pick(owner, 1), "was automatically refunded", "a", "m");`,
      `if (await pageTextIncludes(ledger, "ledger", "admin.ledger.event.sale")) return;`,
      `requireExactly(\n      await pageTextCount(ledger, "ledger", "admin.ledger.human.payment"),\n      1,\n      "r",\n    );`,
      `requireExactly(await exactLinkCount(owner, "Edit"), 1, "e");`,
      `await requireNoExactLink(owner, "Delete", "gone");`,
      `const confirm = await attendeeCatalogButtons(owner, "admin.attendees.delete_submit");`,
    ].join("\n");
    const copy = catalog(
      [
        "Save Payment Provider",
        "Edit",
        "Delete",
        "The payment was automatically refunded.",
      ],
      [
        "admin.ledger.event.sale",
        "admin.ledger.human.payment",
        "admin.attendees.delete_submit",
      ],
      {
        "admin.attendees.delete_submit": "attendees",
        "admin.ledger.event.sale": "ledger",
        "admin.ledger.human.payment": "ledger",
      },
    );

    expect(findLabelIssues(source, copy)).toEqual([]);
  });

  test("requires a clicked control to equal a whole catalog message", () => {
    // "Save" appears inside many messages; a control named "Save" whose
    // message is "Save Changes" must not pass on that overlap.
    const source = `await session.clickButton("Save");`;
    const copy = catalog(["Save Changes", "Save Payment Provider"]);

    const issues = findLabelIssues(source, copy);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toContain("renders exactly");
  });

  test("flags a page-text helper whose key names nothing", () => {
    const source = `if (await pageTextIncludes(ledger, "ledger", "admin.ledger.gone")) {}`;
    const copy = catalog([], ["admin.ledger.event.sale"]);

    const issues = findLabelIssues(source, copy);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toBe(
      'uses key "admin.ledger.gone", which src/locales/en holds nowhere. ' +
        "Give the group and key the page's template reads.",
    );
  });

  test("flags a catalogWords key the catalog holds nowhere", () => {
    const source = `await catalogWords("attendees", "admin.attendees.gone")`;
    const copy = catalog([], ["admin.attendees.refund_submit"]);

    const issues = findLabelIssues(source, copy);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toContain('"admin.attendees.gone"');
  });

  test("reads key calls written in single quotes", () => {
    const source = [
      `await t('settings.gone_one');`,
      `await catalogWords('common', 'common.gone_two');`,
    ].join("\n");
    const copy = catalog([], ["common.save_changes"]);

    const issues = findLabelIssues(source, copy);
    expect(issues.map((issue) => issue.line)).toEqual([1, 2]);
    expect(
      issues.map((issue) => issue.message.match(/"([^"]+)"/)?.[1]),
    ).toEqual(["settings.gone_one", "common.gone_two"]);
  });

  test("flags a catalogWords call that names the wrong group", () => {
    const source = `await catalogWords("common", "settings.save_payment_provider")`;
    const copy = catalog([], ["settings.save_payment_provider"], {
      "settings.save_payment_provider": "settings",
    });

    const issues = findLabelIssues(source, copy);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toBe(
      'loads group "common", but "settings.save_payment_provider" lives in ' +
        '"settings". Name the group that holds the key.',
    );
  });

  test("accepts a catalogWords call that names the holding group", () => {
    const source = `await catalogWords("settings", "settings.save_payment_provider")`;
    const copy = catalog([], ["settings.save_payment_provider"], {
      "settings.save_payment_provider": "settings",
    });

    expect(findLabelIssues(source, copy)).toEqual([]);
  });

  test("says no group holds a key the catalog carries without one", () => {
    const source = `await catalogWords("settings", "orphan.key")`;
    const copy = catalog([], ["orphan.key"]);

    const issues = findLabelIssues(source, copy);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toBe(
      'loads group "settings", but "orphan.key" lives in ' +
        '"no group". Name the group that holds the key.',
    );
  });

  test("ignores a key call quoted inside a string literal", () => {
    const source = `const note = 'an example: t("gone.key") in prose';`;
    const copy = catalog([], []);

    expect(findLabelIssues(source, copy)).toEqual([]);
  });

  test("flags a label the catalog renamed underneath the spec", () => {
    // The 2026-08-27 nightly failure: #2152 renamed the button the Stripe
    // spec clicked, and nothing caught it until the scheduled run.
    const source = `await session.clickButton("Update Stripe Key");`;
    const copy = catalog(["Update {provider} credentials"]);

    const issues = findLabelIssues(source, copy);
    expect(issues.length).toBe(1);
    expect(issues[0]?.line).toBe(1);
    expect(issues[0]?.message).toContain('"Update Stripe Key"');
    expect(issues[0]?.message).toContain("no message in src/locales/en");
  });

  test("flags a page-text marker that no message carries", () => {
    const source = `requirePageText(owner, "Payment gone for", "a", "m")`;
    const copy = catalog(["Payment received for"]);

    const issues = findLabelIssues(source, copy);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toBe(
      'uses "Payment gone for", which no message in src/locales/en renders ' +
        'at all. Match the new copy, or derive it with t("…") as ' +
        "saveCredentials does.",
    );
  });

  test("flags copy whose capitalisation drifted from the catalog", () => {
    const source = `await session.clickButton("Save changes");`;
    const copy = catalog(["Save Changes"]);

    const issues = findLabelIssues(source, copy);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toContain('"Save changes"');
  });

  test("leaves the scenario's own data and pattern matches alone", () => {
    const source = [
      "await session.clickLink(world.scenario.listingName);",
      "await session.clickLink(catalog.kit);",
      `requirePageText(owner, expectedAnswer, "a", "m");`,
      `requirePageText(owner, /refunded/, "a", "m");`,
      "await session.clickButton(`Pay now`);",
    ].join("\n");

    expect(findLabelIssues(source, catalog([]))).toEqual([]);
  });

  test("accepts a t(...) label whose key the catalog holds", () => {
    const source = `await session.clickButton(t("settings.provider.update_credentials", { provider: label }));`;
    const copy = catalog(
      ["Update {provider} credentials"],
      ["settings.provider.update_credentials"],
    );

    expect(findLabelIssues(source, copy)).toEqual([]);
  });
  test("flags a t(...) label whose key the catalog dropped", () => {
    const source = `await session.clickButton(t("settings.provider.update_credentials", { provider: label }));`;
    const copy = catalog(["Update {provider} credentials"]);

    const issues = findLabelIssues(source, copy);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toBe(
      'asks for message key "settings.provider.update_credentials", which ' +
        "src/locales/en holds nowhere. Copy renames leave this driver with " +
        "nothing to click.",
    );
  });

  test("ignores a call site named only in a comment", () => {
    const source = [
      `// session.clickButton("Update Stripe Key") used to live here.`,
      `await session.clickButton("Save Payment Provider");`,
    ].join("\n");
    const copy = catalog(["Save Payment Provider"]);

    expect(findLabelIssues(source, copy)).toEqual([]);
  });

  test("still reads arguments whose strings hold brackets and commas", () => {
    const source = [
      `await session.clickButton("Pay (now), please");`,
      `await session.clickButton('Pay [later], ok');`,
      "await session.clickButton(`Pay {tonight}, fine`);",
    ].join("\n");
    const copy = catalog([
      "Pay (now), please",
      "Pay [later], ok",
      "Pay {tonight}, fine",
    ]);

    expect(findLabelIssues(source, copy)).toEqual([]);
  });

  test("flags a later argument even when earlier ones carry commas", () => {
    // Only a correct structure read keeps each "Gone" phrase the second
    // argument: a comma misread as top-level demotes the phrase into a
    // fragment, and the issue disappears with it.
    const source = [
      `requirePageText(pick(owner, 1), "Gone One", "a", "m");`,
      `requirePageText(pick(["a", "b"]), "Gone Two", "a", "m");`,
      `requirePageText(pick({ a: 1, b: 2 }), "Gone Three", "a", "m");`,
      `requirePageText(fn("x, (y)"), "Gone Four", "a", "m");`,
      `requirePageText("x, (y)", "Gone Five", "a", "m");`,
    ].join("\n");

    const issues = findLabelIssues(source, catalog([]));
    expect(
      issues.map((issue) => issue.message.match(/"(Gone [^"]+)"/)?.[1]),
    ).toEqual(["Gone One", "Gone Two", "Gone Three", "Gone Four", "Gone Five"]);
  });

  test("counts lines from the very first character of the file", () => {
    const issues = findLabelIssues(
      `\nawait session.clickButton("Gone");`,
      catalog([]),
    );

    expect(issues[0]?.line).toBe(2);
  });

  test("reads a single-quoted literal", () => {
    const source = `await session.clickButton('Save changes');`;
    const copy = catalog(["Save Changes"]);

    expect(findLabelIssues(source, copy).length).toBe(1);
  });

  test("reads an apostrophe escaped inside a single-quoted literal", () => {
    const source = `await session.clickButton('Don\\'t save');`;
    const copy = catalog(["Don't save"]);

    expect(findLabelIssues(source, copy)).toEqual([]);
  });

  test("decodes the escapes TypeScript allows in a literal", () => {
    const source = [
      `await session.clickButton("Line\\nbreak");`,
      `await session.clickButton('Tab\\there');`,
      `await session.clickButton("Code \\x27point\\x27");`,
      `await session.clickButton("Curly \\u2019 quote");`,
      `await session.clickButton("Star \\u{2B50} eyes");`,
      `await session.clickButton("A\\'B\\"C\\\\D\\bE\\fF\\rG\\vH\\0I");`,
    ].join("\n");
    const copy = catalog([
      "Line\nbreak",
      "Tab\there",
      "Code 'point'",
      "Curly \u2019 quote",
      "Star \u{2B50} eyes",
      "A'B\"C\\D\bE\fF\rG\vH\0I",
    ]);

    expect(findLabelIssues(source, copy)).toEqual([]);
  });

  test("reads a label split by a line continuation", () => {
    const lf = `await session.clickButton("Save \\\nChanges");`;
    const crlf = `await session.clickButton("Save \\\r\nChanges");`;
    const cr = `await session.clickButton("Save \\\rChanges");`;
    const copy = catalog(["Save Changes"]);

    expect(findLabelIssues(lf, copy)).toEqual([]);
    expect(findLabelIssues(crlf, copy)).toEqual([]);
    expect(findLabelIssues(cr, copy)).toEqual([]);
  });

  test("reports issues in source order", () => {
    const source = [
      `await session.clickButton("First Gone");`,
      `await session.clickButton("Present");`,
      `await session.clickButton("Second Gone");`,
    ].join("\n");
    const copy = catalog(["Present"]);

    const issues = findLabelIssues(source, copy);
    expect(issues.map((issue) => issue.line)).toEqual([1, 3]);
  });

  test("says which argument is missing on a call with none", () => {
    const issues = findLabelIssues("await session.clickButton();", catalog([]));

    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toContain(
      "calls clickButton with no argument 1 to read",
    );
  });

  test("leaves a spread argument alone, for it hides the positions", () => {
    const issues = findLabelIssues(
      "await pageTextCount(...args);",
      catalog([]),
    );

    expect(issues).toEqual([]);
  });
});
