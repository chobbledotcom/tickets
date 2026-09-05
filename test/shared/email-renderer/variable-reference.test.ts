import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { TemplateData } from "#shared/email-renderer.ts";
import { createBaseLiquidEngine } from "#shared/liquid-engine.ts";
import {
  LOOP_EXAMPLE,
  TEMPLATE_VARIABLES,
} from "#templates/components/email-template-reference.tsx";
import { makeTestEntry } from "#test-utils/factories.ts";
import { buildTestData, describeEmailRenderer } from "./test-helpers.ts";

/** An entry whose every template field carries a visible value, so a path
 * that resolves to empty can never pass the render check. */
const fullEntry = (name: string, slug: string, quantity: number) =>
  makeTestEntry(
    { name, slug, unit_price: 1000 },
    {
      address: "1 High Street",
      date: "2026-09-01",
      end_date: "2026-09-03",
      phone: "555-1234",
      price_paid: "2500",
      quantity,
      remaining_balance: 1250,
      special_instructions: "Use gate B",
    },
  );

const buildReferenceData = (): Promise<TemplateData> =>
  buildTestData([
    fullEntry("Summer Fete", "summer-fete", 3),
    fullEntry("Bake Off", "bake-off", 1),
  ]);

const joinPath = (prefix: string, key: string): string =>
  prefix === "" ? key : `${prefix}.${key}`;

/** Every dotted path the built data holds. An array is a loop: the reference
 * names one row of it `entry`, so the element's paths carry that prefix. */
const runtimePaths = (data: TemplateData): Set<string> => {
  const paths = new Set<string>();
  const queue: [prefix: string, value: unknown][] = [["", data]];
  for (const [prefix, value] of queue) {
    if (value === null || typeof value !== "object") {
      paths.add(prefix);
    } else if (Array.isArray(value)) {
      paths.add(prefix);
      const row = value[0];
      if (row !== undefined) queue.push(["entry", row]);
    } else {
      for (const [key, sub] of Object.entries(value)) {
        queue.push([joinPath(prefix, key), sub]);
      }
    }
  }
  return paths;
};

/** The variable paths the reference table shows. A code that filters a
 * literal (the pluralize demo) names no path. */
const displayedPaths = (): Set<string> => {
  const paths = new Set<string>();
  for (const [code] of TEMPLATE_VARIABLES) {
    const variable = code.slice(2, -2).split("|")[0]!.trim();
    if (!/^\d+$/.test(variable)) paths.add(variable);
  }
  return paths;
};

describeEmailRenderer(() => {
  describe("the displayed variable reference", () => {
    test("shows a path for every field the runtime data holds", async () => {
      const data = await buildReferenceData();
      const displayed = displayedPaths();
      const missing = [...runtimePaths(data)].filter(
        (path) => !displayed.has(path),
      );
      expect(missing).toEqual([]);
    });

    test("shows no path the runtime data does not hold", async () => {
      const data = await buildReferenceData();
      const runtime = runtimePaths(data);
      const phantom = [...displayedPaths()].filter(
        (path) => !runtime.has(path),
      );
      expect(phantom).toEqual([]);
    });

    test("renders every snippet the reference shows", async () => {
      const data = await buildReferenceData();
      const engine = createBaseLiquidEngine();
      for (const [code] of TEMPLATE_VARIABLES) {
        // An `entry.*` snippet only resolves inside the loop it belongs to.
        const snippet = code.includes("entry.")
          ? `{% for entry in entries %}${code}{% endfor %}`
          : code;
        const rendered = await engine.parseAndRender(snippet, data);
        expect(rendered.trim(), code).not.toBe("");
      }
    });

    test("renders the reference's money and plural examples exactly", async () => {
      const data = await buildReferenceData();
      const engine = createBaseLiquidEngine();
      expect(
        await engine.parseAndRender("{{ amount_owed | currency }}", data),
      ).toBe("£12.50");
      expect(
        await engine.parseAndRender(
          '{{ 2 | pluralize: "ticket", "tickets" }}',
          data,
        ),
      ).toBe("tickets");
      expect(
        await engine.parseAndRender(
          '{{ 1 | pluralize: "ticket", "tickets" }}',
          data,
        ),
      ).toBe("ticket");
      expect(await engine.parseAndRender("{{ currency }}", data)).toBe("GBP");
    });

    test("the worked loop prints each booked listing's line", async () => {
      const data = await buildReferenceData();
      const engine = createBaseLiquidEngine();
      const loop = await engine.parseAndRender(LOOP_EXAMPLE, data);
      const dates = data.entries[0]!.attendee.date_range_label;
      expect(loop).toContain("Summer Fete: 3 tickets");
      expect(loop).toContain("Bake Off: 1 ticket");
      expect(loop).toContain(dates);
      expect(loop).toContain("£25");
    });
  });
});
