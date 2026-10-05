import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  PublicTicketLink,
  UnavailablePublicUrlRow,
} from "#templates/admin/share-rows.tsx";

describe("public page share rows", () => {
  const availableRow = (): string =>
    String(
      PublicTicketLink({
        href: "https://fair.example/ticket/sunday",
        label: "fair.example/ticket/sunday",
        qrHref: "/ticket/sunday/qr",
      }),
    );

  test("keeps the page link as the row's first content", () => {
    const html = availableRow();
    expect(html).toContain(
      '<a data-share-link href="https://fair.example/ticket/sunday">',
    );
    expect(html).toContain("fair.example/ticket/sunday");
  });

  test("offers Share, QR, and Embed under the link, never beside it", () => {
    const html = availableRow();
    expect(html).toContain('class="share-actions"');
    expect(html).toContain(
      'data-share-url="https://fair.example/ticket/sunday"',
    );
    expect(html).toContain(">Share</button>");
    expect(html).toContain('href="/ticket/sunday/qr"');
    // The Guide section that explains the embed codes.
    expect(html).toContain('href="/admin/guide#listings"');
    // The actions block follows the link inside one wrapping row.
    expect(html.indexOf("data-share-link")).toBeLessThan(
      html.indexOf("share-actions"),
    );
  });

  test("hands the copied label to the client through a data attribute", () => {
    expect(availableRow()).toContain('data-copied-label="Copied"');
  });

  test("the unavailable row keeps its message and shows no actions", () => {
    const html = String(
      UnavailablePublicUrlRow({ message: "This page isn't live yet." }),
    );
    expect(html).toContain("This page isn't live yet.");
    expect(html).toContain("Public URL");
    expect(html).not.toContain("data-share-url");
    expect(html).not.toContain("share-actions");
  });
});
