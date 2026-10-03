import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatBytes } from "#shared/format-units.ts";
import { MAX_ATTACHMENT_SIZE } from "#shared/limits.ts";
import { renderGuideSections } from "#templates/admin/guide/components.tsx";
import { listingsSections } from "#templates/admin/guide/listings.tsx";

describe("listings guide schema", () => {
  test("states the attachment size limit the site actually uses", () => {
    const html = String(renderGuideSections(listingsSections()));
    expect(html).toContain(
      `The largest size is ${formatBytes(MAX_ATTACHMENT_SIZE)}.`,
    );
  });
});
