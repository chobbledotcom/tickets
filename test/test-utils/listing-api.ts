import { expect } from "@std/expect";
import { assertJson } from "#test-utils/assertions.ts";
import { apiRequest } from "#test-utils/session.ts";

type Body = Record<string, unknown>;

type ListingAnswer = { listing: Record<string, any> & { id: number } };

/** POST a body to the admin JSON API listing create route. */
export const postListing = (body: Body): Promise<Response> =>
  apiRequest("/api/admin/listings", { body, method: "POST" });

/** PUT a body to one listing through the admin JSON API. */
export const putListing = (id: number, body: Body): Promise<Response> =>
  apiRequest(`/api/admin/listings/${id}`, { body, method: "PUT" });

/** Create a listing through the admin JSON API and assert 201. The answer
 *  must not carry the internal slug_index. */
export const expectListingCreated = (
  body: Body,
  check?: (listing: ListingAnswer["listing"]) => void,
): Promise<ListingAnswer> =>
  assertJson<ListingAnswer>(postListing(body), 201, ({ listing }) => {
    expect(Object.keys(listing)).not.toContain("slug_index");
    check?.(listing);
  });
