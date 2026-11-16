import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ADMIN_API_EXAMPLE_EXTERNAL_SOURCE,
  ADMIN_API_EXAMPLE_EXTERNAL_SOURCE_LINK,
  EXTERNAL_SOURCE_ENDPOINTS,
} from "#shared/admin-api-example/external-sources.ts";
import { documentedBodies, documentedRoutes } from "./helpers.ts";

const SOURCES = "/api/admin/external-sources";
const ONE_SOURCE = `${SOURCES}/:sourceId`;
const LINKS = `${ONE_SOURCE}/links`;
const ONE_LINK = `${LINKS}/:linkId`;

const bodiesOf = documentedBodies(EXTERNAL_SOURCE_ENDPOINTS);

const SOURCE = {
  created: "2026-11-03T09:00:00.000Z",
  id: 1,
  name: "Stripe invoices",
  url_pattern: "https://dashboard.stripe.com/invoices/{external_id}",
};

const LINK = {
  created: "2026-11-03T09:05:00.000Z",
  external_id: "in_3Nx8Yz",
  id: 1,
  link_id: 7,
  link_type: "attendee",
  source_id: 1,
  url: "https://dashboard.stripe.com/invoices/in_3Nx8Yz",
};

const NAMED_LINKS = { links: [{ ...LINK, source_name: "Stripe invoices" }] };

describe("documented external source endpoints", () => {
  test("the example source and the example link hold the documented values", () => {
    expect(ADMIN_API_EXAMPLE_EXTERNAL_SOURCE).toEqual(SOURCE);
    expect(ADMIN_API_EXAMPLE_EXTERNAL_SOURCE_LINK).toEqual(LINK);
  });

  test("every source route and every link route is documented in order", () => {
    expect(documentedRoutes(EXTERNAL_SOURCE_ENDPOINTS)).toEqual([
      `GET ${SOURCES}`,
      `GET ${ONE_SOURCE}`,
      `POST ${SOURCES}`,
      `PUT ${ONE_SOURCE}`,
      `DELETE ${ONE_SOURCE}`,
      `GET ${SOURCES}/lookup`,
      `GET ${SOURCES}/links`,
      `GET ${LINKS}`,
      `POST ${LINKS}`,
      `PUT ${ONE_LINK}`,
      `DELETE ${ONE_LINK}`,
    ]);
  });

  test("every route says what it does", () => {
    const short = EXTERNAL_SOURCE_ENDPOINTS.filter(
      ({ description }) => description.length < 20,
    );

    expect(short).toEqual([]);
  });

  test("a source create, update, and delete carry the documented bodies", () => {
    const created = {
      name: "Shipping labels",
      url_pattern: "https://carrier.example/labels/{external_id}",
    };

    expect(bodiesOf("POST", SOURCES)).toEqual({
      request: created,
      response: { source: { ...SOURCE, ...created } },
    });
    expect(bodiesOf("PUT", ONE_SOURCE)).toEqual({
      request: { name: SOURCE.name, url_pattern: SOURCE.url_pattern },
      response: { source: SOURCE },
    });
    expect(bodiesOf("DELETE", ONE_SOURCE).request).toEqual({
      confirm_identifier: "Stripe invoices",
    });
  });

  test("the link reads answer with the example link", () => {
    expect(bodiesOf("GET", `${SOURCES}/lookup`).response).toEqual(NAMED_LINKS);
    expect(bodiesOf("GET", `${SOURCES}/links`).response).toEqual(NAMED_LINKS);
    expect(bodiesOf("GET", LINKS).response).toEqual({ links: [LINK] });
  });

  test("a link create, update, and delete carry the documented bodies", () => {
    const sent = {
      external_id: "in_3Nx8Yz",
      link_id: 7,
      link_type: "attendee",
    };

    expect(bodiesOf("POST", LINKS)).toEqual({
      request: sent,
      response: { link: LINK },
    });
    expect(bodiesOf("PUT", ONE_LINK)).toEqual({
      request: { ...sent, external_id: "in_4Qb2Lm" },
      response: { link: { ...LINK, external_id: "in_4Qb2Lm" } },
    });
    expect(bodiesOf("DELETE", ONE_LINK)).toEqual({
      request: { confirm_identifier: "in_3Nx8Yz" },
      response: { status: "ok" },
    });
  });
});
