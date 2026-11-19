/**
 * The admin entry (`src/ui/client/admin.ts`) wires the listing images field.
 * The entry runs every initializer at import time, so this test installs a
 * full DOM first and then imports it.
 */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import type { ImageOption } from "#shared/images/picker.ts";
import { ListingImagesField } from "#templates/admin/listings/listing-images.tsx";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { createDomInstaller, requireElement } from "#test-utils/happy-dom.ts";
import { PICKER_TEMPLATE } from "#test-utils/markdown-editor-dom.ts";
import {
  fetchStubHolder,
  optionByName,
  restoreHeldStub,
  twoImageList,
  untilReady,
} from "#test-utils/markdown-image-dialog.ts";

const { installDom, cleanup } = createDomInstaller([
  "navigator",
  "getComputedStyle",
  "MutationObserver",
  "Event",
  "HTMLElement",
  "HTMLAnchorElement",
  "HTMLButtonElement",
  "HTMLDialogElement",
  "HTMLFormElement",
  "HTMLImageElement",
  "HTMLInputElement",
  "HTMLLIElement",
  "HTMLSelectElement",
  "HTMLTemplateElement",
  "HTMLTextAreaElement",
]);

afterEach(cleanup);
afterEach(restoreHeldStub);

const sectionHtml = (selected: readonly ImageOption[] = []): string =>
  `<form action="/admin/listing" method="post">${String(
    ListingImagesField({ selected }),
  )}</form>`;

test("the admin entry enhances the listing images field", async () => {
  fetchStubHolder.stub = stubFetch(twoImageList());
  const window = installDom(PICKER_TEMPLATE + sectionHtml());

  // The entry runs its initializers at import time. Import it after this
  // test's DOM exists, so the side effect finds the listing field.
  await import("#src/ui/client/admin.ts");
  requireElement<HTMLButtonElement>(
    window.document,
    "[data-listing-images-trigger]",
  ).click();
  const dialog = requireElement<HTMLDialogElement>(
    window.document,
    ".md-image-dialog",
  );
  const grid = requireElement<HTMLElement>(window.document, ".md-image-grid");
  await untilReady(grid);

  expect(dialog.open).toBe(true);
  expect(optionByName(window, "Alpha").textContent).toBe("Alpha");
});
