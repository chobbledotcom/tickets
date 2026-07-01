/**
 * Tests for signed QR booking tokens.
 *
 * These tests guard the two invariants the whole feature relies on:
 *  1. A token signed for one slug cannot be verified against another (domain
 *     separation — prevents one listing's QR working on another).
 *  2. Any tampering with payload or signature fails verification; expired
 *     tokens are rejected.
 */

import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { base64ToBase64Url, toBase64 } from "#shared/crypto/utils.ts";
import {
  buildQrBookPayload,
  QR_TOKEN_MAX_AGE_S,
  signQrBookToken,
  verifyQrBookToken,
} from "#shared/qr-token.ts";
import { setupTestEncryptionKey } from "#test-utils";

describe("qr-token", () => {
  beforeEach(() => {
    setupTestEncryptionKey();
  });

  describe("buildQrBookPayload", () => {
    test("fills defaults for optional fields", () => {
      const payload = buildQrBookPayload({});
      expect(payload.n).toBe("");
      expect(payload.v).toBe(-1);
      expect(payload.q).toBe(1);
      expect(payload.d).toBe("");
    });

    test("sets expiry to now plus default max age", () => {
      const nowS = Math.floor(Date.now() / 1000);
      const payload = buildQrBookPayload({});
      expect(payload.e).toBeGreaterThanOrEqual(nowS + QR_TOKEN_MAX_AGE_S - 2);
      expect(payload.e).toBeLessThanOrEqual(nowS + QR_TOKEN_MAX_AGE_S + 2);
    });

    test("carries supplied values into the payload", () => {
      const payload = buildQrBookPayload({
        date: "2026-05-01",
        name: "Ada",
        quantity: 3,
        value: 1500,
      });
      expect(payload.n).toBe("Ada");
      expect(payload.v).toBe(1500);
      expect(payload.q).toBe(3);
      expect(payload.d).toBe("2026-05-01");
    });
  });

  describe("signQrBookToken", () => {
    test("produces a token with the qr1. prefix and two dot-separated parts", async () => {
      const token = await signQrBookToken("my-listing", buildQrBookPayload({}));
      expect(token.startsWith("qr1.")).toBe(true);
      const rest = token.slice(4);
      expect(rest.split(".").length).toBe(2);
    });

    test("produces the same token for the same slug and payload (determinism)", async () => {
      const payload = buildQrBookPayload({ name: "Ada", value: 1000 });
      const a = await signQrBookToken("slug", payload);
      const b = await signQrBookToken("slug", payload);
      expect(a).toBe(b);
    });

    test("produces different tokens for the same payload under different slugs", async () => {
      const payload = buildQrBookPayload({ name: "Ada", value: 1000 });
      const a = await signQrBookToken("slug-a", payload);
      const b = await signQrBookToken("slug-b", payload);
      expect(a).not.toBe(b);
    });
  });

  describe("verifyQrBookToken", () => {
    test("accepts a freshly signed token and returns the original payload", async () => {
      const original = buildQrBookPayload({
        date: "2026-05-01",
        name: "Ada",
        quantity: 2,
        value: 2500,
      });
      const token = await signQrBookToken("listing-slug", original);
      const result = await verifyQrBookToken("listing-slug", token);
      expect(result).toEqual(original);
    });

    test("rejects a token used for a different slug (domain separation)", async () => {
      const token = await signQrBookToken(
        "listing-a",
        buildQrBookPayload({ name: "Ada" }),
      );
      const result = await verifyQrBookToken("listing-b", token);
      expect(result).toBe(null);
    });

    test("rejects a token with tampered signature", async () => {
      const token = await signQrBookToken(
        "listing",
        buildQrBookPayload({ value: 500 }),
      );
      const tampered = `${token.slice(0, -4)}XXXX`;
      expect(await verifyQrBookToken("listing", tampered)).toBe(null);
    });

    test("rejects a token with tampered payload", async () => {
      const token = await signQrBookToken(
        "listing",
        buildQrBookPayload({ value: 500 }),
      );
      const rest = token.slice(4);
      const dotIdx = rest.indexOf(".");
      const hmac = rest.slice(dotIdx);
      // Replace the payload with a different one (same length to look similar)
      const otherPayload = buildQrBookPayload({ value: 999999 });
      const otherToken = await signQrBookToken("listing", otherPayload);
      const otherEncoded = otherToken.slice(4).split(".")[0]!;
      const forged = `qr1.${otherEncoded}${hmac}`;
      expect(await verifyQrBookToken("listing", forged)).toBe(null);
    });

    test("rejects a token whose payload cannot be base64-decoded", async () => {
      expect(
        await verifyQrBookToken("listing", "qr1.!!!not-base64!!!.sig"),
      ).toBe(null);
    });

    test("rejects a token without the qr1. prefix", async () => {
      const token = await signQrBookToken("listing", buildQrBookPayload({}));
      const stripped = token.slice(4);
      expect(await verifyQrBookToken("listing", stripped)).toBe(null);
    });

    test("rejects an empty string", async () => {
      expect(await verifyQrBookToken("listing", "")).toBe(null);
    });

    test("rejects a token missing the dot separator", async () => {
      expect(await verifyQrBookToken("listing", "qr1.nodot")).toBe(null);
    });

    test("rejects a token with empty signature", async () => {
      expect(await verifyQrBookToken("listing", "qr1.payload.")).toBe(null);
    });

    test("rejects an expired token", async () => {
      using time = new FakeTime(1_700_000_000_000);
      const token = await signQrBookToken(
        "listing",
        buildQrBookPayload({ name: "Ada", value: 100 }),
      );
      // Advance past the max-age window
      time.tick((QR_TOKEN_MAX_AGE_S + 10) * 1000);
      expect(await verifyQrBookToken("listing", token)).toBe(null);
    });

    test("accepts a token still within its validity window", async () => {
      using time = new FakeTime(1_700_000_000_000);
      const token = await signQrBookToken(
        "listing",
        buildQrBookPayload({ name: "Ada", value: 100 }),
      );
      // Advance by just under the max-age window
      time.tick((QR_TOKEN_MAX_AGE_S - 10) * 1000);
      const result = await verifyQrBookToken("listing", token);
      expect(result?.n).toBe("Ada");
    });

    test("rejects a token with an unreasonably far-future expiry", async () => {
      // Caller passes a huge maxAgeSeconds to try to bypass the max-age check
      const payload = buildQrBookPayload({
        maxAgeSeconds: QR_TOKEN_MAX_AGE_S * 100,
        name: "Ada",
      });
      const token = await signQrBookToken("listing", payload);
      expect(await verifyQrBookToken("listing", token)).toBe(null);
    });

    test("rejects a token whose signed payload fails shape validation", async () => {
      // Construct a token where the HMAC is correctly computed over a
      // non-conforming JSON payload. Guards the branch where signature
      // passes but decodePayload rejects the shape.
      const encoder = new TextEncoder();
      const bogus = base64ToBase64Url(
        toBase64(encoder.encode(JSON.stringify({ not: "a payload" }))),
      );
      const message = `qr-book:listing:${bogus}`;
      const hmac = base64ToBase64Url(await hmacHash(message));
      const token = `qr1.${bogus}.${hmac}`;
      expect(await verifyQrBookToken("listing", token)).toBe(null);
    });

    test("rejects a token whose payload is signed but not valid base64", async () => {
      // HMAC is computed over the literal "encoded" string regardless of
      // whether it's valid base64, so we can get past the signature check
      // with a payload that fails decoding. Guards the catch branch.
      const encoded = "not-valid-base64-@@@";
      const message = `qr-book:listing:${encoded}`;
      const hmac = base64ToBase64Url(await hmacHash(message));
      expect(await verifyQrBookToken("listing", `qr1.${encoded}.${hmac}`)).toBe(
        null,
      );
    });
  });
});
