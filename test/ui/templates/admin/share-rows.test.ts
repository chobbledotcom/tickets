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
        qrHref: "/ticket/sunday/qr",
      }),
    );

  test("shows the full URL as the row's first content", () => {
    const html = availableRow();
    expect(html).toContain(
      '<a data-share-link href="https://fair.example/ticket/sunday">',
    );
    // The link text equals its href, so a manual selection copies the whole
    // address and not a schemeless label.
    expect(html).toContain(">https://fair.example/ticket/sunday</a>");
  });

  test("offers Share, QR, and Embed under the link, never beside it", () => {
    const html = availableRow();
    expect(html).toContain('class="share-actions"');
    expect(html).toContain(
      'data-share-url="https://fair.example/ticket/sunday"',
    );
    expect(html).toContain(">Share</button>");
    expect(html).toContain('href="/ticket/sunday/qr"');
    // The Guide answer that explains the embed codes, at its own anchor.
    expect(html).toContain('href="/admin/guide#embed_booking_form"');
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
