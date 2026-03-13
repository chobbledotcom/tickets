import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildEventTicketClass,
  buildEventTicketObject,
  buildGoogleWalletUrl,
  buildJwtPayload,
  type GooglePassData,
  type GoogleWalletCredentials,
  isValidGooglePrivateKey,
  signJwt,
} from "#lib/google-wallet.ts";
import { generateGoogleTestCreds } from "#test-utils";

const makePassData = (
  overrides: Partial<GooglePassData> = {},
): GooglePassData => ({
  serialNumber: "ABC123",
  organizationName: "Test Platform",
  eventName: "Summer Concert",
  eventDate: "2026-06-15T19:00:00Z",
  eventLocation: "Town Hall",
  attendeeDate: null,
  quantity: 1,
  pricePaid: 0,
  currencyCode: "GBP",
  checkinUrl: "https://example.com/checkin/ABC123",
  ...overrides,
});

describe("google-wallet", () => {
  let creds: GoogleWalletCredentials;

  // Generate creds once before all tests
  const ensureCreds = async () => {
    if (!creds) creds = await generateGoogleTestCreds();
  };

  describe("buildEventTicketClass", () => {
    test("includes issuer name and event name", async () => {
      await ensureCreds();
      const cls = buildEventTicketClass(makePassData(), creds);
      expect(cls.issuerName).toBe("Test Platform");
      const eventName = cls.eventName as { defaultValue: { value: string } };
      expect(eventName.defaultValue!.value).toBe("Summer Concert");
    });

    test("includes class id based on issuer and serial", async () => {
      await ensureCreds();
      const cls = buildEventTicketClass(makePassData(), creds);
      expect(cls.id).toBe("1234567890.ABC123-class");
    });

    test("includes date/time when eventDate is present", async () => {
      await ensureCreds();
      const cls = buildEventTicketClass(makePassData(), creds);
      const dt = cls.dateTime as Record<string, string>;
      expect(dt.start).toBe("2026-06-15T19:00:00Z");
    });

    test("omits date/time when eventDate is empty", async () => {
      await ensureCreds();
      const cls = buildEventTicketClass(makePassData({ eventDate: "" }), creds);
      expect(cls.dateTime).toBeUndefined();
    });

    test("includes venue when eventLocation is present", async () => {
      await ensureCreds();
      const cls = buildEventTicketClass(makePassData(), creds);
      const venue = cls.venue as { name: { defaultValue: { value: string } } };
      expect(venue.name!.defaultValue!.value).toBe("Town Hall");
    });

    test("omits venue when eventLocation is empty", async () => {
      await ensureCreds();
      const cls = buildEventTicketClass(
        makePassData({ eventLocation: "" }),
        creds,
      );
      expect(cls.venue).toBeUndefined();
    });
  });

  describe("buildEventTicketObject", () => {
    test("includes object id and class reference", async () => {
      await ensureCreds();
      const obj = buildEventTicketObject(makePassData(), creds);
      expect(obj.id).toBe("1234567890.ABC123");
      expect(obj.classId).toBe("1234567890.ABC123-class");
    });

    test("includes QR code barcode", async () => {
      await ensureCreds();
      const obj = buildEventTicketObject(makePassData(), creds);
      const barcode = obj.barcode as Record<string, string>;
      expect(barcode.type).toBe("QR_CODE");
      expect(barcode.value).toBe("https://example.com/checkin/ABC123");
    });

    test("state is ACTIVE", async () => {
      await ensureCreds();
      const obj = buildEventTicketObject(makePassData(), creds);
      expect(obj.state).toBe("ACTIVE");
    });

    test("omits textModulesData when no optional fields", async () => {
      await ensureCreds();
      const obj = buildEventTicketObject(makePassData(), creds);
      expect(obj.textModulesData).toBeUndefined();
    });

    test("includes booking date when present", async () => {
      await ensureCreds();
      const obj = buildEventTicketObject(
        makePassData({ attendeeDate: "2026-06-15" }),
        creds,
      );
      const modules = obj.textModulesData as Array<Record<string, string>>;
      const bookingDate = modules.find((m) => m.id === "booking-date");
      expect(bookingDate).toBeDefined();
      expect(bookingDate!.body).toBe("2026-06-15");
    });

    test("includes quantity when greater than 1", async () => {
      await ensureCreds();
      const obj = buildEventTicketObject(makePassData({ quantity: 3 }), creds);
      const modules = obj.textModulesData as Array<Record<string, string>>;
      const qty = modules.find((m) => m.id === "qty");
      expect(qty).toBeDefined();
      expect(qty!.body).toBe("3");
    });

    test("omits quantity when equal to 1", async () => {
      await ensureCreds();
      const obj = buildEventTicketObject(makePassData({ quantity: 1 }), creds);
      expect(obj.textModulesData).toBeUndefined();
    });

    test("includes price when greater than 0", async () => {
      await ensureCreds();
      const obj = buildEventTicketObject(
        makePassData({ pricePaid: 2500, currencyCode: "EUR" }),
        creds,
      );
      const modules = obj.textModulesData as Array<Record<string, string>>;
      const price = modules.find((m) => m.id === "price");
      expect(price).toBeDefined();
      expect(price!.body).toBe("25 EUR");
    });

    test("omits price when zero", async () => {
      await ensureCreds();
      const obj = buildEventTicketObject(makePassData({ pricePaid: 0 }), creds);
      expect(obj.textModulesData).toBeUndefined();
    });

    test("converts price using currency decimal places for JPY (0 decimals)", async () => {
      await ensureCreds();
      const obj = buildEventTicketObject(
        makePassData({ pricePaid: 1000, currencyCode: "JPY" }),
        creds,
      );
      const modules = obj.textModulesData as Array<Record<string, string>>;
      const price = modules.find((m) => m.id === "price");
      expect(price!.body).toBe("1000 JPY");
    });
  });

  describe("buildJwtPayload", () => {
    test("includes required JWT claims", async () => {
      await ensureCreds();
      const payload = buildJwtPayload(makePassData(), creds);
      expect(payload.iss).toBe("test@test-project.iam.gserviceaccount.com");
      expect(payload.aud).toBe("google");
      expect(payload.typ).toBe("savetowallet");
      expect(typeof payload.iat).toBe("number");
    });

    test("includes event ticket class and object in payload", async () => {
      await ensureCreds();
      const jwt = buildJwtPayload(makePassData(), creds);
      const inner = jwt.payload as Record<string, unknown[]>;
      expect(inner.eventTicketClasses).toHaveLength(1);
      expect(inner.eventTicketObjects).toHaveLength(1);
    });
  });

  describe("signJwt", () => {
    test("produces a valid three-part JWT", async () => {
      await ensureCreds();
      const payload = buildJwtPayload(makePassData(), creds);
      const jwt = await signJwt(payload, creds.serviceAccountKey);
      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);
    });

    test("header indicates RS256 algorithm", async () => {
      await ensureCreds();
      const payload = buildJwtPayload(makePassData(), creds);
      const jwt = await signJwt(payload, creds.serviceAccountKey);
      const headerJson = atob(
        jwt.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"),
      );
      const header = JSON.parse(headerJson);
      expect(header.alg).toBe("RS256");
      expect(header.typ).toBe("JWT");
    });

    test("payload contains the original data", async () => {
      await ensureCreds();
      const payload = buildJwtPayload(makePassData(), creds);
      const jwt = await signJwt(payload, creds.serviceAccountKey);
      const payloadPart = jwt.split(".")[1]!;
      // Add padding if needed
      const padded =
        payloadPart + "=".repeat((4 - (payloadPart.length % 4)) % 4);
      const payloadJson = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
      const decoded = JSON.parse(payloadJson);
      expect(decoded.iss).toBe(creds.serviceAccountEmail);
      expect(decoded.aud).toBe("google");
    });

    test("produces different JWTs for different serial numbers", async () => {
      await ensureCreds();
      const a = await signJwt(
        buildJwtPayload(makePassData({ serialNumber: "AAA" }), creds),
        creds.serviceAccountKey,
      );
      const b = await signJwt(
        buildJwtPayload(makePassData({ serialNumber: "BBB" }), creds),
        creds.serviceAccountKey,
      );
      expect(a).not.toBe(b);
    });
  });

  describe("buildGoogleWalletUrl", () => {
    test("produces a URL starting with Google Wallet save prefix", async () => {
      await ensureCreds();
      const url = await buildGoogleWalletUrl(makePassData(), creds);
      expect(url).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    });

    test("URL contains a valid JWT after the prefix", async () => {
      await ensureCreds();
      const url = await buildGoogleWalletUrl(makePassData(), creds);
      const jwt = url.replace("https://pay.google.com/gp/v/save/", "");
      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);
    });
  });

  describe("isValidGooglePrivateKey", () => {
    test("returns true for a valid PKCS8 PEM key", async () => {
      await ensureCreds();
      expect(await isValidGooglePrivateKey(creds.serviceAccountKey)).toBe(true);
    });

    test("returns false for garbage input", async () => {
      expect(await isValidGooglePrivateKey("not a key")).toBe(false);
    });

    test("returns false for empty string", async () => {
      expect(await isValidGooglePrivateKey("")).toBe(false);
    });
  });
});
