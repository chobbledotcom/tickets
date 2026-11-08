/**
 * An answer that names a button or a field must use the word the page shows.
 * The catalog holds each label, so a rename fails here instead of leaving the
 * guide telling an admin to look for something no page shows.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";

/** The answers that name a label, with the catalog key each label comes from. */
const NAMED_LABELS: readonly (readonly [string, readonly string[]])[] = [
  ["available_settings", ["settings.tax"]],
  ["what_is_tax", ["settings.tax", "settings.save_tax"]],
  [
    "how_do_tax_settings_work",
    [
      "settings.tax_none",
      "settings.tax_add",
      "settings.tax_included",
      "settings.tax_rate",
    ],
  ],
  [
    "tax_in_money_and_refunds",
    [
      "admin.ledger.account.tax",
      "admin.ledger.human.vat",
      "admin.ledger.human.vat_reduction",
      "admin.ledger.human.refund_vat",
    ],
  ],
  ["ledger_accounts_explained", ["admin.ledger.account.tax"]],
  [
    "ledger_entry_kinds",
    [
      "admin.ledger.human.vat",
      "admin.ledger.human.vat_reduction",
      "admin.ledger.human.refund_vat",
    ],
  ],
  ["what_are_external_sources", ["features.external_sources.name"]],
  [
    "turn_external_sources_on",
    [
      "settings.title",
      "features.title",
      "features.external_sources.name",
      "features.status.enabled",
    ],
  ],
  ["external_source_url_pattern", ["features.external_sources.not_named"]],
  [
    "delivery_run_sheet",
    ["deliveries.edit_template", "settings.run_sheet.title"],
  ],
  ["invoices_how_they_work", ["invoices.action.update_preview"]],
];

/** A label as the guide quotes it in a sentence: the page ends a standalone
 *  message with a full stop, and the answer quotes the words alone. */
const quoted = (label: string): string => label.replace(/\.$/, "");

describe("guide answers name the labels the admin pages show", () => {
  for (const [answer, labelKeys] of NAMED_LABELS) {
    test(`${answer} uses the site's own labels`, () => {
      const text = t(`guide.a.${answer}`);
      const missing = labelKeys
        .map((key) => quoted(t(key)))
        .filter((label) => !text.includes(label));
      expect(missing).toEqual([]);
    });
  }
});
