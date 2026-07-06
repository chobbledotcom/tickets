import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { WalletPassData } from "#routes/tickets/token-utils.ts";
import {
  buildGoogleWalletUrl,
  buildJwtPayload,
  isValidGooglePrivateKey,
  signJwt,
} from "#shared/google-wallet.ts";
import { generateGoogleTestCreds } from "#test-utils/crypto.ts";

const makePassData = (
  overrides: Partial<WalletPassData> = {},
): WalletPassData => ({
  attendeeDate: null,
  checkinUrl: "https://example.com/checkin/ABC123",
  currencyCode: "GBP",
  listingDate: "2026-06-15T19:00:00Z",
  listingLocation: "Town Hall",
  listingName: "Summer Concert",
  organizationName: "Test Platform",
  pricePaid: 0,
  quantity: 1,
  serialNumber: "ABC123",
  ...overrides,
});

const findTextModule = (
  obj: { textModulesData: Array<Record<string, string>> },
  id: string,
): Record<string, string> =>
  obj.textModulesData.find((m) => m.id === id) as Record<string, string>;

describe("google-wallet", () => {
  // generateGoogleTestCreds() is memoized, so one call yields the shared creds
  // for every test.
  const creds = generateGoogleTestCreds();

  describe("buildGoogleWalletUrl integration", () => {
    /** Helper to extract JWT payload from a Google Wallet save URL */
    const extractPayload = async (data: WalletPassData) => {
      const url = await buildGoogleWalletUrl(data, creds);
      const jwt = url.replace("https://pay.google.com/gp/v/save/", "");
      const payloadPart = jwt.split(".")[1]!;
      const padded =
        payloadPart + "=".repeat((4 - (payloadPart.length % 4)) % 4);
      return JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
    };

    test("includes class with issuer name, listing name, and correct ids", async () => {
      const decoded = await extractPayload(makePassData());
      const cls = decoded.payload.listingTicketClasses[0];
      expect(cls.id).toBe("1234567890.ABC123-class");
      expect(cls.issuerName).toBe("Test Platform");
      expect(cls.listingName.defaultValue.value).toBe("Summer Concert");
    });

    test("includes object with id, classId, QR barcode, and ACTIVE state", async () => {
      const decoded = await extractPayload(makePassData());
      const obj = decoded.payload.listingTicketObjects[0];
      expect(obj.id).toBe("1234567890.ABC123");
      expect(obj.classId).toBe("1234567890.ABC123-class");
      expect(obj.state).toBe("ACTIVE");
      expect(obj.barcode.type).toBe("QR_CODE");
      expect(obj.barcode.value).toBe("https://example.com/checkin/ABC123");
    });

    test("includes dateTime when listingDate is present", async () => {
      const decoded = await extractPayload(makePassData());
      const cls = decoded.payload.listingTicketClasses[0];
      expect(cls.dateTime.start).toBe("2026-06-15T19:00:00Z");
    });

    test("omits dateTime when listingDate is empty", async () => {
      const decoded = await extractPayload(makePassData({ listingDate: "" }));
      const cls = decoded.payload.listingTicketClasses[0];
      expect(cls.dateTime).toBeUndefined();
    });

    test("includes venue when listingLocation is present", async () => {
      const decoded = await extractPayload(makePassData());
      const cls = decoded.payload.listingTicketClasses[0];
      expect(cls.venue.name.defaultValue.value).toBe("Town Hall");
    });

    test("omits venue when listingLocation is empty", async () => {
      const decoded = await extractPayload(
        makePassData({ listingLocation: "" }),
      );
      const cls = decoded.payload.listingTicketClasses[0];
      expect(cls.venue).toBeUndefined();
    });

    test("omits textModulesData when no optional fields", async () => {
      const decoded = await extractPayload(makePassData());
      const obj = decoded.payload.listingTicketObjects[0];
      expect(obj.textModulesData).toBeUndefined();
    });

    test("includes booking date when attendeeDate is present", async () => {
      const decoded = await extractPayload(
        makePassData({ attendeeDate: "2026-06-15" }),
      );
      const obj = decoded.payload.listingTicketObjects[0];
      const bookingDate = obj.textModulesData.find(
        (m: Record<string, string>) => m.id === "booking-date",
      );
      expect(bookingDate).toBeDefined();
      expect(bookingDate.body).toBe("2026-06-15");
    });

    test("includes quantity when greater than 1", async () => {
      const decoded = await extractPayload(makePassData({ quantity: 3 }));
      const obj = decoded.payload.listingTicketObjects[0];
      const qty = findTextModule(obj, "qty");
      expect(qty).toBeDefined();
      expect(qty.body).toBe("3");
    });

    test("omits quantity when equal to 1", async () => {
      const decoded = await extractPayload(makePassData({ quantity: 1 }));
      const obj = decoded.payload.listingTicketObjects[0];
      expect(obj.textModulesData).toBeUndefined();
    });

    test("includes price with 2-decimal currency (GBP)", async () => {
      const decoded = await extractPayload(
        makePassData({ currencyCode: "EUR", pricePaid: 2500 }),
      );
      const obj = decoded.payload.listingTicketObjects[0];
      const price = findTextModule(obj, "price");
      expect(price).toBeDefined();
      expect(price.body).toBe("25 EUR");
    });

    test("omits price when zero", async () => {
      const decoded = await extractPayload(makePassData({ pricePaid: 0 }));
      const obj = decoded.payload.listingTicketObjects[0];
      expect(obj.textModulesData).toBeUndefined();
    });

    test("formats price with 0-decimal currency (JPY)", async () => {
      const decoded = await extractPayload(
        makePassData({ currencyCode: "JPY", pricePaid: 1000 }),
      );
      const obj = decoded.payload.listingTicketObjects[0];
      const price = findTextModule(obj, "price");
      expect(price.body).toBe("1000 JPY");
    });
  });

  describe("buildJwtPayload", () => {
    test("includes required JWT claims", async () => {
      const payload = buildJwtPayload(makePassData(), creds);
      expect(payload.iss).toBe("test@test-project.iam.gserviceaccount.com");
      expect(payload.aud).toBe("google");
      expect(payload.typ).toBe("savetowallet");
      expect(typeof payload.iat).toBe("number");
    });

    test("includes listing ticket class and object in payload", async () => {
      const jwt = buildJwtPayload(makePassData(), creds);
      const inner = jwt.payload as Record<string, unknown[]>;
      expect(inner.listingTicketClasses).toHaveLength(1);
      expect(inner.listingTicketObjects).toHaveLength(1);
    });
  });

  describe("signJwt", () => {
    test("produces a valid three-part JWT", async () => {
      const payload = buildJwtPayload(makePassData(), creds);
      const jwt = await signJwt(payload, creds.serviceAccountKey);
      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);
    });

    test("header indicates RS256 algorithm", async () => {
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
      const url = await buildGoogleWalletUrl(makePassData(), creds);
      expect(url).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    });

    test("URL contains a valid JWT after the prefix", async () => {
      const url = await buildGoogleWalletUrl(makePassData(), creds);
      const jwt = url.replace("https://pay.google.com/gp/v/save/", "");
      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);
    });
  });

  describe("isValidGooglePrivateKey", () => {
    test("returns true for a valid PKCS8 PEM key", async () => {
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
