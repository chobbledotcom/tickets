import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  signAttachmentUrl,
  verifyAttachmentUrl,
} from "#shared/attachment-url.ts";
import { matchGroup, setupTestEncryptionKey } from "#test-utils";

describe("signAttachmentUrl", () => {
  let fakeTime: FakeTime;

  beforeEach(() => {
    setupTestEncryptionKey();
    fakeTime = new FakeTime(1700000000000);
  });

  afterEach(() => {
    fakeTime.restore();
  });

  test("produces URL with correct path format", async () => {
    const url = await signAttachmentUrl(42, 7);
    expect(url).toMatch(/^\/attachment\/42\?a=7&exp=\d+&sig=.+$/);
  });

  test("includes numeric expiry timestamp roughly 3600s in the future", async () => {
    const url = await signAttachmentUrl(1, 2);
    const exp = Number.parseInt(matchGroup(url, /exp=(\d+)/), 10);
    const nowS = Math.floor(1700000000000 / 1000);
    expect(exp - nowS).toBe(3600);
  });

  test("generates unique signatures for different listing/attendee combos", async () => {
    const url1 = await signAttachmentUrl(1, 2);
    const url2 = await signAttachmentUrl(1, 3);
    const url3 = await signAttachmentUrl(2, 2);
    const sig1 = new URL(`http://x${url1}`).searchParams.get("sig");
    const sig2 = new URL(`http://x${url2}`).searchParams.get("sig");
    const sig3 = new URL(`http://x${url3}`).searchParams.get("sig");
    expect(sig1).not.toBe(sig2);
    expect(sig1).not.toBe(sig3);
    expect(sig2).not.toBe(sig3);
  });

  test("uses base64url encoding in signature", async () => {
    const url = await signAttachmentUrl(1, 2);
    const sig = new URL(`http://x${url}`).searchParams.get("sig")!;
    expect(sig).not.toMatch(/[+/=]/);
  });
});

describe("verifyAttachmentUrl", () => {
  let fakeTime: FakeTime;

  beforeEach(() => {
    setupTestEncryptionKey();
    fakeTime = new FakeTime(1700000000000);
  });

  afterEach(() => {
    fakeTime.restore();
  });

  const signAndVerify = async (midStep?: () => void): Promise<boolean> => {
    const url = await signAttachmentUrl(5, 10);
    const params = new URL(`http://x${url}`).searchParams;
    midStep?.();
    return verifyAttachmentUrl(5, 10, params.get("exp")!, params.get("sig")!);
  };

  test("accepts a freshly signed URL's parameters", async () => {
    expect(await signAndVerify()).toBe(true);
  });

  test("rejects tampered signature", async () => {
    const url = await signAttachmentUrl(5, 10);
    const params = new URL(`http://x${url}`).searchParams;
    const tampered = `${params.get("sig")?.slice(0, -4)}XXXX`;
    const result = await verifyAttachmentUrl(
      5,
      10,
      params.get("exp")!,
      tampered,
    );
    expect(result).toBe(false);
  });

  test("rejects wrong listing ID", async () => {
    const url = await signAttachmentUrl(5, 10);
    const params = new URL(`http://x${url}`).searchParams;
    const result = await verifyAttachmentUrl(
      999,
      10,
      params.get("exp")!,
      params.get("sig")!,
    );
    expect(result).toBe(false);
  });

  test("rejects wrong attendee ID", async () => {
    const url = await signAttachmentUrl(5, 10);
    const params = new URL(`http://x${url}`).searchParams;
    const result = await verifyAttachmentUrl(
      5,
      999,
      params.get("exp")!,
      params.get("sig")!,
    );
    expect(result).toBe(false);
  });

  test("rejects expired URL", async () => {
    expect(await signAndVerify(() => fakeTime.tick(3601 * 1000))).toBe(false);
  });

  test("rejects non-numeric exp", async () => {
    const result = await verifyAttachmentUrl(5, 10, "notanumber", "somesig");
    expect(result).toBe(false);
  });

  test("rejects exp far in the future beyond MAX_AGE_S + 60", async () => {
    const farFutureExp = String(Math.floor(1700000000000 / 1000) + 3600 + 61);
    const result = await verifyAttachmentUrl(5, 10, farFutureExp, "somesig");
    expect(result).toBe(false);
  });

  test("rejects empty string sig", async () => {
    const url = await signAttachmentUrl(5, 10);
    const params = new URL(`http://x${url}`).searchParams;
    const result = await verifyAttachmentUrl(5, 10, params.get("exp")!, "");
    expect(result).toBe(false);
  });
});
