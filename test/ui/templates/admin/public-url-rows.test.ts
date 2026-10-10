import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { PublicUrlRows } from "#templates/admin/public-url-rows.tsx";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const availableRows = (): string =>
  String(
    PublicUrlRows({
      href: "https://fair.example/ticket/sunday",
      id: 7,
      iframeCode:
        '<iframe src="https://fair.example/ticket/sunday?iframe=true"></iframe>',
      kind: "available",
      qrHref: "/ticket/sunday/qr",
      scriptCode: '<script src="https://fair.example/embed.js"></script>',
    }),
  );

describe("the Public URL rows", () => {
  const dom = createDomInstaller();

  afterEach(async () => {
    // Awaited: happy-dom's window close starts a settle timer of its own, and
    // an un-awaited close can land it after the test, which the leak detector
    // flags.
    await dom.cleanup();
  });

  test("shows the full URL as the row's first content", () => {
    const html = availableRows();
    expect(html).toContain(
      '<a data-share-link href="https://fair.example/ticket/sunday">',
    );
    // The link text equals its href, so a manual selection copies the whole
    // address and not a schemeless label.
    expect(html).toContain(">https://fair.example/ticket/sunday</a>");
  });

  test("offers Share, QR code, and Embed under the link, never beside it", () => {
    const html = availableRows();
    expect(html).toContain('class="public-url-actions"');
    expect(html).toContain(
      'data-share-url="https://fair.example/ticket/sunday"',
    );
    expect(html).toContain(">Share</button>");
    expect(html).toContain('href="/ticket/sunday/qr"');
    // The actions block follows the link inside one wrapping row.
    expect(html.indexOf("data-share-link")).toBeLessThan(
      html.indexOf("public-url-actions"),
    );
  });

  test("no class on the row says share, so ad blockers keep it visible", () => {
    // uBlock Origin's Annoyance lists hide elements whose class says "share".
    const classes = availableRows().match(/class="[^"]*"/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const className of classes) {
      expect(className).not.toContain("share");
    }
  });

  test("Embed is a label for the hidden toggle, and the embed code rows start hidden", () => {
    const html = availableRows();
    expect(html).toContain(
      '<label class="small-action" for="embed-toggle-7">Embed</label>',
    );
    expect(html).toContain(
      'class="visually-hidden embed-toggle" id="embed-toggle-7" type="checkbox"',
    );
    // The two embed rows carry the class the stylesheet hides until the
    // toggle is ticked.
    expect((html.match(/class="embed-code-row"/g) ?? []).length).toBe(2);
  });

  /** The rendered row installed onto the DOM, with its hidden toggle and its
   * Embed label handed back. */
  const setupToggle = () => {
    const window = dom.installDom(availableRows());
    const toggle = window.document.getElementById(
      "embed-toggle-7",
    ) as unknown as HTMLInputElement;
    const embed = window.document.querySelector(
      'label[for="embed-toggle-7"]',
    ) as unknown as HTMLLabelElement;
    return { embed, toggle, window };
  };

  test("pressing Embed ticks the hidden toggle", () => {
    const { embed, toggle } = setupToggle();
    expect(toggle.checked).toBe(false);
    embed.click();
    expect(toggle.checked).toBe(true);
  });

  test("keyboard focus on the hidden toggle lights up the Embed label", async () => {
    const { embed, toggle, window } = setupToggle();
    // The hidden checkbox stays in the tab order, and the label's for=
    // association is its accessible name.
    expect(toggle.disabled).toBe(false);
    expect(Array.from(toggle.labels ?? [])).toContain(embed);
    toggle.focus();
    expect(window.document.activeElement).toBe(toggle);
    // The checkbox itself is visually hidden, so the stylesheet must light
    // the label up when the toggle takes keyboard focus.
    const stylesheet = await Deno.readTextFile(
      "src/ui/static/_public-url-rows.scss",
    );
    expect(stylesheet).toContain(
      ".embed-toggle:focus-visible ~ .public-url-row label",
    );
    expect(stylesheet).toContain("outline: 2px solid var(--color-secondary);");
  });

  test("hands the copied label to the client through a data attribute", () => {
    expect(availableRows()).toContain('data-copied-label="Copied"');
  });

  test("the unavailable rows keep their message and show no actions", () => {
    const html = String(
      PublicUrlRows({
        kind: "unavailable",
        message: "This page isn't live yet.",
      }),
    );
    expect(html).toContain("This page isn't live yet.");
    expect(html).toContain("Public URL");
    expect(html).not.toContain("data-share-url");
    expect(html).not.toContain("public-url-actions");
  });
});
