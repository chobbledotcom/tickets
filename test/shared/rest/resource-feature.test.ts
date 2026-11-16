import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { gatedByFeature } from "#shared/rest/resource-feature.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { featureSetting } from "#test-utils/settings.ts";

const REQUEST = new Request("http://localhost/api/admin/attributes");

/** A route that answers with the id it was called for. */
const echoId: RouteHandlerFn = (_request, params) =>
  new Response(`reached ${params.attributeId}`);

/** The answer of one gated route: its status and its body text. */
const answerOf = async (
  routes: Record<string, RouteHandlerFn>,
  key: string,
): Promise<[number, string]> => {
  const route = routes[key];
  if (route === undefined) throw new Error(`No route ${key}`);
  const response = await route(REQUEST, { attributeId: 7 });
  if (response === null) throw new Error(`The route ${key} did not answer`);
  return [response.status, await response.text()];
};

describeWithEnv("resource feature gate", { db: true }, () => {
  afterEach(() => {
    settings.clearTestOverride("enabled_features");
  });

  test("a resource of no feature keeps its own route table", () => {
    const routes = { "GET /api/admin/holidays": echoId };

    expect(gatedByFeature(ADMIN_API_RESOURCES.holidays, routes)).toBe(routes);
  });

  test("every route of a resource refuses while its feature is off", async () => {
    settings.setForTest(featureSetting());
    const routes = gatedByFeature(ADMIN_API_RESOURCES.attributes, {
      "GET /api/admin/attributes": echoId,
      "PUT /api/admin/attributes/:attributeId": echoId,
    });
    const refusal = JSON.stringify({
      error:
        "The attributes feature is disabled. Turn it on in Settings, then try again.",
    });

    expect(await answerOf(routes, "GET /api/admin/attributes")).toEqual([
      403,
      refusal,
    ]);
    expect(
      await answerOf(routes, "PUT /api/admin/attributes/:attributeId"),
    ).toEqual([403, refusal]);
  });

  test("each resource names its own feature in the refusal", async () => {
    settings.setForTest(featureSetting());
    const refusalOf = async (entry: { path: string }) => {
      const key = `GET /api/admin/${entry.path}`;
      const [, body] = await answerOf(
        gatedByFeature(entry as never, { [key]: echoId }),
        key,
      );
      return JSON.parse(body).error;
    };

    expect([
      await refusalOf(ADMIN_API_RESOURCES.questions),
      await refusalOf(ADMIN_API_RESOURCES["site-pages"]),
      await refusalOf(ADMIN_API_RESOURCES["external-sources"]),
    ]).toEqual([
      "The questions feature is disabled. Turn it on in Settings, then try again.",
      "The site feature is disabled. Turn it on in Settings, then try again.",
      "The external sources feature is disabled. Turn it on in Settings, then try again.",
    ]);
  });

  test("a route answers as itself while the feature is on", async () => {
    settings.setForTest(featureSetting("attributes"));
    const routes = gatedByFeature(ADMIN_API_RESOURCES.attributes, {
      "GET /api/admin/attributes": echoId,
    });

    expect(await answerOf(routes, "GET /api/admin/attributes")).toEqual([
      200,
      "reached 7",
    ]);
  });
});
