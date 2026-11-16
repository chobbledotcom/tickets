import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attributeDocs } from "#shared/admin-api-example/attributes.ts";
import { documentedBodies, documentedRoutes, OPEN_ACCESS } from "./helpers.ts";

const DOCS = attributeDocs(OPEN_ACCESS);
const bodiesOf = documentedBodies(DOCS);

const ATTRIBUTES = "/api/admin/attributes";
const ONE = `${ATTRIBUTES}/:attributeId`;
const OPTIONS = `${ONE}/options`;
const ONE_OPTION = `${OPTIONS}/:optionId`;

const EASY = { attribute_id: 6, id: 11, sort_order: 0, text: "Easy" };
const HARD = { attribute_id: 6, id: 12, sort_order: 1, text: "Hard" };
const ATTRIBUTE = {
  id: 6,
  name: "Difficulty",
  options: [EASY, HARD],
  sort_order: 2,
};

describe("documented attribute endpoints", () => {
  test("every attribute route and every option route is documented in order", () => {
    expect(documentedRoutes(DOCS)).toEqual([
      "GET /api/admin/attributes",
      "GET /api/admin/attributes/:attributeId",
      "POST /api/admin/attributes",
      "PUT /api/admin/attributes/:attributeId",
      "DELETE /api/admin/attributes/:attributeId",
      "POST /api/admin/attributes/:attributeId/options",
      "PUT /api/admin/attributes/:attributeId/options/:optionId",
      "DELETE /api/admin/attributes/:attributeId/options/:optionId",
    ]);
  });

  test("every route names the owner as its only caller", () => {
    expect(
      DOCS.filter(({ description }) => !description.includes("(owner only")),
    ).toEqual([]);
  });

  test("the reads answer with the example attribute and its two options", () => {
    const read = (path: string) => bodiesOf("GET", path).response;

    expect([read(ATTRIBUTES), read(ONE)]).toEqual([
      { attributes: [ATTRIBUTE] },
      { attribute: ATTRIBUTE },
    ]);
  });

  test("a create, an update, and a delete carry the documented bodies", () => {
    expect(bodiesOf("POST", ATTRIBUTES)).toEqual({
      request: { name: "Difficulty" },
      response: { attribute: { ...ATTRIBUTE, options: [] } },
    });
    expect(bodiesOf("PUT", ONE)).toEqual({
      request: { name: "Difficulty (Updated)" },
      response: { attribute: { ...ATTRIBUTE, name: "Difficulty (Updated)" } },
    });
    expect(bodiesOf("DELETE", ONE).request).toEqual({
      confirm_identifier: "Difficulty",
    });
  });

  test("an option add, rename, and delete carry the documented bodies", () => {
    const withOptions = (options: unknown[]) => ({
      attribute: { ...ATTRIBUTE, options },
    });

    expect(bodiesOf("POST", OPTIONS)).toEqual({
      request: { text: "Medium" },
      response: withOptions([
        EASY,
        HARD,
        { attribute_id: 6, id: 13, sort_order: 2, text: "Medium" },
      ]),
    });
    expect(bodiesOf("PUT", ONE_OPTION)).toEqual({
      request: { text: "Very hard" },
      response: withOptions([EASY, { ...HARD, text: "Very hard" }]),
    });
    expect(bodiesOf("DELETE", ONE_OPTION).request).toEqual({
      confirm_identifier: "Hard",
    });
  });
});
