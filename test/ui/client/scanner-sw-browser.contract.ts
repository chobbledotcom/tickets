/**
 * Browser contract for the scanner service worker's registration: the policy
 * the served scanner page runs under and the scope the browser grants the
 * worker script. The worker registers from the real page a door opens, so a
 * policy that refuses a same-origin worker, or a scope that misses the
 * scanner pages, fails here and not at the door.
 *
 * The direct tests in `scanner-sw.test.ts` drive the worker's fetch logic at
 * the worker's own scope; the static-assets suite pins the served headers.
 * This file proves what only a real page and a real browser show.
 *
 * Runs under `deno task test:screenshot-contract` (Chromium required), never
 * in the main suite. The task builds the bundles the worker precaches.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  describeWithBrowser,
  withSignedInPage,
} from "#test-utils/browser-contract.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const WORKER_PATH = "/admin/scanner-sw.js";

describeWithBrowser(
  "the scanner service worker's registration on the served scanner page",
  { db: true },
  (contract) => {
    test("registers under the page's CSP and receives the /admin/ scope", async () => {
      // The suite's beforeEach opens the test database, so the listing is
      // created here and not in beforeAll.
      const { id: listingId } = await createTestListing();
      // Each context starts with no stored worker, so the registration under
      // test is the page's own first one.
      await withSignedInPage(
        contract.browser,
        contract.baseUrl,
        async (page) => {
          await page.goto(`/admin/listing/${listingId}/scanner`);
          const workerResponse = await page.request.get(WORKER_PATH);
          expect(workerResponse.status()).toBe(200);
          // The script's own directory is already the widest scope the browser
          // grants, so no allowance header is needed. Its presence would say
          // the worker moved out of /admin/.
          expect(
            workerResponse.headers()["service-worker-allowed"],
          ).toBeUndefined();

          // The registration the scanner page makes once the offline door
          // lands. A policy that refuses a same-origin worker rejects it.
          const registration = await page.evaluate(async (workerPath) => {
            const found = await navigator.serviceWorker.register(workerPath);
            return { scope: found.scope };
          }, WORKER_PATH);
          // The script's directory is the default scope, and it covers every
          // scanner page shape: /admin/scanner, /admin/listing/N/scanner, and
          // /admin/groups/N/scanner.
          expect(registration.scope).toBe(`${contract.baseUrl}/admin/`);

          // Activated and claimed: the install fetched the assets, activation
          // ran, and the worker controls the page that registered it.
          await page.waitForFunction(
            () => navigator.serviceWorker.controller !== null,
            undefined,
            { timeout: 10_000 },
          );
          expect(
            await page.evaluate(
              () => navigator.serviceWorker.controller?.scriptURL ?? null,
            ),
          ).toBe(`${contract.baseUrl}${WORKER_PATH}`);

          // A later navigation under the scope starts under the worker's
          // control, so the doors page loads the offline shell's coverage too.
          await page.goto("/admin/scanner");
          expect(
            await page.evaluate(
              () => navigator.serviceWorker.controller?.scriptURL ?? null,
            ),
          ).toBe(`${contract.baseUrl}${WORKER_PATH}`);
        },
      );
    });
  },
);
