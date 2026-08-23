import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups, t } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/manifest.ts";
import { SCHEMA_ATLAS_MACHINES } from "#shared/schema-atlas/index.ts";
import { adminSchemaAtlasPage } from "#templates/admin/schema-atlas.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

const html = (): string =>
  adminSchemaAtlasPage({ adminLevel: "owner" }, "light", []);

describe("the system map page", () => {
  beforeAll(async () => {
    await setupAdminPageTest();
    await ensureMessageGroups(MESSAGE_GROUPS);
  });

  test("renders under the settings nav with its own title", () => {
    expect(html()).toContain("<h1>System map</h1>");
    expect(html()).toContain('href="/admin/schema"');
  });

  test("the legend names each actor with its own colour class", () => {
    const page = html();
    expect(page).toMatch(/<div class="prose">\s*<p class="schema-legend">/);
    expect(page).toContain("</strong> <span");
    for (const actor of ["system", "provider", "owner"]) {
      expect(page).toContain(
        `class="schema-actor schema-actor-${actor}">${t(`schema.legend.${actor}`)}`,
      );
    }
    // Exactly two commas join the three actors.
    expect(page.match(/<\/span>, <span/g)).toHaveLength(2);
  });

  test("every atlas label resolves to catalog copy, not to a raw key", () => {
    const page = html();
    for (const machine of SCHEMA_ATLAS_MACHINES) {
      expect(page).not.toContain(machine.titleKey);
      expect(page).toContain(t(machine.titleKey));
      for (const state of machine.states) {
        expect(page).not.toContain(`>${state.labelKey}<`);
        expect(page).toContain(t(state.labelKey));
        expect(page).toContain(t(state.detailKey));
        for (const edge of state.edges) {
          expect(page).toContain(t(edge.labelKey));
        }
      }
    }
  });

  test("the static list answers the map question for a partial return", () => {
    const page = html();
    // The one-exit owner decision, in plain words, with its way forward.
    expect(page).toContain("Your decision needed: some money is back");
    expect(page).toContain("You confirm the money came back → Money back");
    // A terminal state says so.
    expect(page).toContain("Recorded: done");
    expect(page).toContain("Nothing. This state is an ending.");
  });

  test("marks the start states and carries each machine's section", () => {
    const page = html();
    expect(page).toContain("Ready to send · where every record starts");
    expect(page).toContain('id="refund"');
    expect(page).toContain('id="review"');
    expect(page).toContain('id="row"');
    expect(page).toContain("A refund at the payment provider");
    expect(page).toContain("A payment row kept for review");
    expect(page).toContain("One payment row's held work");
  });

  test("keeps every static and interactive schema hook", () => {
    const page = html();
    const states = SCHEMA_ATLAS_MACHINES.flatMap((machine) => machine.states);
    expect(page.match(/class="schema-state"/g)).toHaveLength(states.length);
    expect(page.match(/class="schema-facts"/g)).toHaveLength(
      states.filter((state) => state.facts.length > 0).length,
    );
    expect(page.match(/class="schema-machine"/g)).toHaveLength(
      SCHEMA_ATLAS_MACHINES.length,
    );
    expect(page.match(/class="schema-widget"/g)).toHaveLength(
      SCHEMA_ATLAS_MACHINES.length,
    );
    expect(page.match(/class="schema-widget-hint"/g)).toHaveLength(
      SCHEMA_ATLAS_MACHINES.length,
    );
  });

  test("the live check answers clean when the scan found nothing", () => {
    const page = html();
    expect(page).toContain('id="schema-check"');
    expect(page).toContain("All stored records fit the system rules.");
  });

  test("the live check lists each flagged record in plain words", () => {
    const page = adminSchemaAtlasPage({ adminLevel: "owner" }, "light", [
      {
        key: "armed_without_claim",
        kind: "payment",
        recordId: "cs_seam",
      },
    ]);
    expect(page).toContain(
      "A refund is set to send, but no job holds this row. <code>cs_seam</code>",
    );
    expect(page).not.toContain("All stored records fit the system rules.");
  });

  test("the live check names a payment with no charge record", () => {
    const page = adminSchemaAtlasPage({ adminLevel: "owner" }, "light", [
      {
        key: "claim_without_charge",
        kind: "payment",
        recordId: "cs_without_charge",
      },
    ]);
    expect(page).toContain(
      "A job holds this row, but its payment has no charge record. " +
        "<code>cs_without_charge</code>",
    );
  });

  test("the live check names an unknown SumUp state", () => {
    const page = adminSchemaAtlasPage({ adminLevel: "owner" }, "light", [
      {
        key: "sumup_unknown_state",
        kind: "sumup",
        recordId: "idx_unknown",
        state: "abandoned",
      },
    ]);
    expect(page).toContain(
      "A SumUp recovery record has a state this site does not know.",
    );
    expect(page).toContain("<code>idx_unknown</code> <code>abandoned</code>");
  });

  test("the live check names a SumUp checkout id mismatch", () => {
    const page = adminSchemaAtlasPage({ adminLevel: "owner" }, "light", [
      {
        key: "sumup_checkout_id_mismatch",
        kind: "sumup",
        recordId: "idx_mismatch",
        state: "staged",
      },
    ]);
    expect(page).toContain(
      "A SumUp recovery record's state and checkout ID do not match.",
    );
    expect(page).toContain("<code>idx_mismatch</code> <code>staged</code>");
  });

  test("the live check names a SumUp check time mismatch", () => {
    const page = adminSchemaAtlasPage({ adminLevel: "owner" }, "light", [
      {
        key: "sumup_check_time_mismatch",
        kind: "sumup",
        recordId: "idx_clock",
        state: "waiting",
      },
    ]);
    expect(page).toContain(
      "A SumUp recovery record's state and next check time do not match.",
    );
    expect(page).toContain("<code>idx_clock</code> <code>waiting</code>");
  });

  test("embeds the resolved diagram data as safe JSON", () => {
    const page = html();
    const start = page.indexOf('<script id="schema-atlas-data"');
    const end = page.indexOf("</script>", start);
    expect(start).toBeGreaterThan(-1);
    const body = page.slice(page.indexOf(">", start) + 1, end);
    expect(body).not.toContain("<");
    const parsed = JSON.parse(body) as {
      machines: {
        states: {
          edges: { to: string }[];
          id: string;
          label: string;
        }[];
      }[];
    };
    expect(parsed.machines.map((machine) => machine.states.length)).toEqual(
      SCHEMA_ATLAS_MACHINES.map((machine) => machine.states.length),
    );
    const refund = parsed.machines[0]!;
    const choice = refund.states.find(
      (state) => state.id === "choice_returned",
    );
    expect(choice?.label).toBe("Your decision needed: some money is back");
    expect(choice?.edges.map((edge) => edge.to)).toEqual(["returned"]);
  });
});
