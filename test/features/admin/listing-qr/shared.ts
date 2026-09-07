/** Shared helpers for the admin QR generator tests: token extraction and a
 * curried POST that mints a token and verifies it against the listing. */

import { expect } from "@std/expect";
import { verifyQrBookToken } from "#shared/qr-token.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Extract the ?t= token from a generated QR booking link */
export const extractToken = (html: string): string | null => {
  const match = html.match(/\/qr-book\?t=([^"\s&]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
};

/** A verified QR booking token's payload. */
type QrPayload = NonNullable<Awaited<ReturnType<typeof verifyQrBookToken>>>;

export const extractAndVerifyToken = async (
  html: string,
  slug: string,
): Promise<{ payload: QrPayload; token: string }> => {
  const token = extractToken(html);
  expect(token).not.toBeNull();
  const payload = await verifyQrBookToken(slug, token!);
  if (payload === null) {
    throw new Error(`QR token failed verification against ${slug}`);
  }
  return { payload, token: token! };
};

/** Post the generator form for `listing` and verify the token it mints. */
export const postQr =
  (listing: { id: number; slug: string }) =>
  async (
    fields: Record<string, string>,
  ): Promise<{
    body: string;
    payload: QrPayload;
    response: Response;
    token: string;
  }> => {
    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/qr`,
      fields,
    );
    const body = await response.text();
    const { payload, token } = await extractAndVerifyToken(body, listing.slug);
    return { body, payload, response, token };
  };
