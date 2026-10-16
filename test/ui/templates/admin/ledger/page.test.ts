/** The ledger page shell: the spec render around the stats, the range
 *  controls, the transfer table, and the guide footer. */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { account } from "#shared/ledger/account.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { names, renderLedger, transfer } from "./helpers.ts";

describe("the ledger page shell", () => {
  beforeAll(setupAdminPageTest);

  test("renders the full page shell around the transfers", () => {
    const move = transfer({ source: account("attendee", 1) });
    const html = renderLedger(
      [move],
      names({ attendees: new Map([[1, "Ada"]]) }),
    );

    expect(html).toContain('data-page-family="admin"');
    // The admin nav has no Ledger item, so the page lights no nav link.
    expect(html).not.toContain('<a class="active" href="/admin/ledger">');
    expect(html).toContain(`<title>${t("admin.ledger.heading")}</title>`);
    expect(html).toContain(`${t("admin.ledger.guide")}`);
    expect(html).toContain("Ada");
  });
});
