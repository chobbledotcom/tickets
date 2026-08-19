import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { unzipSync } from "fflate";
import { isValidRsaPrivateKey } from "#crypto/rsa-private-key.ts";
import { isValidAppleCertificate } from "#shared/apple-wallet/certificate.ts";
import {
  buildPkpass,
  generatePassJson,
  type PassData,
  padAuthToken,
  type SigningCredentials,
  sha1Hex,
  trimAuthToken,
} from "#shared/apple-wallet.ts";
import { WALLET_ICONS } from "#shared/wallet-icons.ts";
import { generateTestCerts } from "#test-utils/crypto.ts";

/** Type for eventTicket field groups in pass.json */
type TicketFields = {
  primaryFields: Record<string, unknown>[];
  secondaryFields: Record<string, unknown>[];
  auxiliaryFields: Record<string, unknown>[];
  backFields: Record<string, unknown>[];
};

const makePassData = (overrides: Partial<PassData> = {}): PassData => ({
  attendeeDate: null,
  checkinUrl: "https://example.com/checkin/ABC123",
  currencyCode: "GBP",
  description: "Ticket for Summer Concert",
  listingDate: "2026-06-15T19:00:00Z",
  listingLocation: "Town Hall",
  listingName: "Summer Concert",
  organizationName: "Test Platform",
  pricePaid: 0,
  quantity: 1,
  serialNumber: "ABC123",
  webServiceURL: "https://example.com",
  ...overrides,
});

describe("apple-wallet", () => {
  // Certs are cached in generateTestCerts — no per-test RSA keygen
  const creds: SigningCredentials = generateTestCerts();

  describe("buildPkpass integration", () => {
    /** Helper to extract and parse pass.json from a pkpass ZIP */
    const extractPassJson = (pkpass: Uint8Array) =>
      JSON.parse(new TextDecoder().decode(unzipSync(pkpass)["pass.json"]!));

    test("includes all required top-level fields and barcode", async () => {
      const pass = extractPassJson(await buildPkpass(makePassData(), creds));

      expect(pass.formatVersion).toBe(1);
      expect(pass.passTypeIdentifier).toBe("pass.com.test.tickets");
      expect(pass.teamIdentifier).toBe("TESTTEAM01");
      expect(pass.serialNumber).toBe("ABC123");
      expect(pass.organizationName).toBe("Test Platform");
      expect(pass.description).toBe("Ticket for Summer Concert");

      const barcodes = pass.barcodes as Record<string, string>[];
      expect(barcodes).toHaveLength(1);
      expect(barcodes[0]!.format).toBe("PKBarcodeFormatQR");
      expect(barcodes[0]!.message).toBe("https://example.com/checkin/ABC123");
      expect(barcodes[0]!.messageEncoding).toBe("iso-8859-1");

      const ticket = pass.eventTicket as TicketFields;
      expect(pass.listingTicket).toBeUndefined();
      expect(ticket.primaryFields).toEqual([
        { key: "listing", label: "LISTING", value: "Summer Concert" },
      ]);

      const dateField = ticket.secondaryFields.find(
        (f: Record<string, unknown>) => f.key === "date",
      );
      expect(dateField).toEqual({
        dateStyle: "PKDateStyleMedium",
        key: "date",
        label: "DATE",
        timeStyle: "PKDateStyleShort",
        value: "2026-06-15T19:00:00Z",
      });

      const locationField = ticket.secondaryFields.find(
        (f: Record<string, unknown>) => f.key === "location",
      );
      expect(locationField).toBeDefined();
      expect(locationField!.value).toBe("Town Hall");

      expect(pass.relevantDate).toBe("2026-06-15T19:00:00Z");

      expect(pass.foregroundColor).toBe("rgb(0, 0, 0)");
      expect(pass.backgroundColor).toBe("rgb(255, 255, 255)");
      expect(pass.labelColor).toBe("rgb(100, 100, 100)");

      expect(pass.webServiceURL).toBe("https://example.com");
      expect(pass.authenticationToken).toBe("ABC123----------");
      expect(
        (pass.authenticationToken as string).length,
      ).toBeGreaterThanOrEqual(16);
    });

    test("omits date, location, qty, and price when data is empty or default", async () => {
      const pass = extractPassJson(
        await buildPkpass(
          makePassData({
            listingDate: "",
            listingLocation: "",
            pricePaid: 0,
            quantity: 1,
          }),
          creds,
        ),
      );
      const ticket = pass.eventTicket as TicketFields;

      expect(
        ticket.secondaryFields.find(
          (f: Record<string, unknown>) => f.key === "date",
        ),
      ).toBeUndefined();
      expect(pass.relevantDate).toBeUndefined();

      expect(
        ticket.secondaryFields.find(
          (f: Record<string, unknown>) => f.key === "location",
        ),
      ).toBeUndefined();

      expect(
        ticket.auxiliaryFields.find(
          (f: Record<string, unknown>) => f.key === "qty",
        ),
      ).toBeUndefined();

      expect(
        ticket.auxiliaryFields.find(
          (f: Record<string, unknown>) => f.key === "price",
        ),
      ).toBeUndefined();
    });

    test("includes quantity, price, and booking date when present", async () => {
      const pass = extractPassJson(
        await buildPkpass(
          makePassData({
            attendeeDate: "2026-06-15",
            currencyCode: "EUR",
            pricePaid: 2500,
            quantity: 2,
          }),
          creds,
        ),
      );
      const ticket = pass.eventTicket as TicketFields;

      const qtyField = ticket.auxiliaryFields.find(
        (f: Record<string, unknown>) => f.key === "qty",
      );
      expect(qtyField).toBeDefined();
      expect(qtyField!.value).toBe(2);

      const priceField = ticket.auxiliaryFields.find(
        (f: Record<string, unknown>) => f.key === "price",
      );
      expect(priceField).toBeDefined();
      expect(priceField!.value).toBe(25);
      expect(priceField!.currencyCode).toBe("EUR");

      const bookingField = ticket.auxiliaryFields.find(
        (f: Record<string, unknown>) => f.key === "booking-date",
      );
      expect(bookingField).toBeDefined();
      expect(bookingField!.value).toBe("2026-06-15");
    });

    test("uses custom colors when provided", async () => {
      const pass = extractPassJson(
        await buildPkpass(
          makePassData({
            backgroundColor: "rgb(0, 0, 255)",
            foregroundColor: "rgb(255, 0, 0)",
            labelColor: "rgb(0, 255, 0)",
          }),
          creds,
        ),
      );

      expect(pass.foregroundColor).toBe("rgb(255, 0, 0)");
      expect(pass.backgroundColor).toBe("rgb(0, 0, 255)");
      expect(pass.labelColor).toBe("rgb(0, 255, 0)");
    });

    test("uses default colors when optional values are empty", () => {
      const pass = generatePassJson(
        makePassData({
          backgroundColor: "",
          foregroundColor: "",
          labelColor: "",
        }),
        creds,
      );
      expect(pass.backgroundColor).toBe("rgb(255, 255, 255)");
      expect(pass.foregroundColor).toBe("rgb(0, 0, 0)");
      expect(pass.labelColor).toBe("rgb(100, 100, 100)");
    });

    test("includes the smallest positive price", () => {
      const pass = generatePassJson(makePassData({ pricePaid: 1 }), creds);
      const ticket = pass.eventTicket as TicketFields;
      expect(ticket.auxiliaryFields).toContainEqual({
        currencyCode: "GBP",
        key: "price",
        label: "PRICE",
        value: 0.01,
      });
    });
  });

  describe("padAuthToken / trimAuthToken", () => {
    test("pads short tokens to 16 characters", () => {
      expect(padAuthToken("ABC123")).toBe("ABC123----------");
      expect(padAuthToken("ABC123")).toHaveLength(16);
    });

    test("pads 10-char ticket tokens to 16 characters", () => {
      expect(padAuthToken("803357EE59")).toBe("803357EE59------");
      expect(padAuthToken("803357EE59")).toHaveLength(16);
    });

    test("does not pad tokens already at 16 characters", () => {
      const long = "ABCDEF1234567890";
      expect(padAuthToken(long)).toBe(long);
    });

    test("trimAuthToken reverses padAuthToken", () => {
      expect(trimAuthToken(padAuthToken("ABC123"))).toBe("ABC123");
      expect(trimAuthToken(padAuthToken("803357EE59"))).toBe("803357EE59");
    });

    test("trimAuthToken handles unpadded tokens", () => {
      expect(trimAuthToken("ABCDEF1234567890")).toBe("ABCDEF1234567890");
    });
  });

  describe("buildPkpass", () => {
    test("produces a valid ZIP with pass.json, icons, and manifest hashes", async () => {
      const data = makePassData();
      const pkpass = await buildPkpass(data, creds);
      expect(pkpass).toBeInstanceOf(Uint8Array);
      expect(pkpass.length).toBeGreaterThan(0);

      const files = unzipSync(pkpass);
      expect(files["pass.json"]).toBeDefined();
      expect(files["icon.png"]).toBeDefined();
      expect(files["icon@2x.png"]).toBeDefined();
      expect(files["icon@3x.png"]).toBeDefined();
      expect(files["manifest.json"]).toBeDefined();
      expect(files.signature).toBeDefined();

      // pass.json matches generatePassJson
      const passJson = JSON.parse(
        new TextDecoder().decode(files["pass.json"]!),
      );
      const expected = generatePassJson(data, creds);
      expect(passJson).toEqual(expected);

      // manifest SHA-1 hashes are correct for all content files
      const manifest = JSON.parse(
        new TextDecoder().decode(files["manifest.json"]!),
      );
      expect(manifest["pass.json"]).toBe(await sha1Hex(files["pass.json"]!));
      expect(manifest["icon.png"]).toBe(await sha1Hex(files["icon.png"]!));
      expect(manifest["icon@2x.png"]).toBe(
        await sha1Hex(files["icon@2x.png"]!),
      );
      expect(manifest["icon@3x.png"]).toBe(
        await sha1Hex(files["icon@3x.png"]!),
      );
    });

    test("produces different pkpass for different serial numbers", async () => {
      const [a, b] = await Promise.all([
        buildPkpass(makePassData({ serialNumber: "AAA" }), creds),
        buildPkpass(makePassData({ serialNumber: "BBB" }), creds),
      ]);
      const aJson = JSON.parse(
        new TextDecoder().decode(unzipSync(a)["pass.json"]!),
      );
      const bJson = JSON.parse(
        new TextDecoder().decode(unzipSync(b)["pass.json"]!),
      );
      expect(aJson.serialNumber).toBe("AAA");
      expect(bJson.serialNumber).toBe("BBB");
    });
  });

  describe("WALLET_ICONS", () => {
    test("contains all three required icon sizes", () => {
      expect(WALLET_ICONS["icon.png"]).toBeInstanceOf(Uint8Array);
      expect(WALLET_ICONS["icon@2x.png"]).toBeInstanceOf(Uint8Array);
      expect(WALLET_ICONS["icon@3x.png"]).toBeInstanceOf(Uint8Array);
    });

    test("each icon is a valid PNG", () => {
      for (const icon of Object.values(WALLET_ICONS)) {
        // PNG signature: 0x89 P N G \r \n 0x1a \n
        expect(icon[0]).toBe(137);
        expect(icon[1]).toBe(80);
        expect(icon[2]).toBe(78);
        expect(icon[3]).toBe(71);
      }
    });
  });

  describe("isValidAppleCertificate", () => {
    test("returns true for a valid PEM certificate", async () => {
      expect(await isValidAppleCertificate(creds.signingCert)).toBe(true);
    });

    test("returns false for a private key PEM", async () => {
      expect(await isValidAppleCertificate(creds.signingKey)).toBe(false);
    });

    test("returns false for garbage input", async () => {
      expect(await isValidAppleCertificate("not a certificate")).toBe(false);
    });
  });

  describe("isValidRsaPrivateKey", () => {
    test("returns true for a valid PEM private key", async () => {
      expect(await isValidRsaPrivateKey(creds.signingKey)).toBe(true);
    });

    test("returns false for a certificate PEM", async () => {
      expect(await isValidRsaPrivateKey(creds.signingCert)).toBe(false);
    });

    test("returns false for garbage input", async () => {
      expect(await isValidRsaPrivateKey("not a key")).toBe(false);
    });
  });

  describe("currency-aware price formatting", () => {
    test("converts price using currency decimal places for JPY (0 decimals)", () => {
      const pass = generatePassJson(
        makePassData({ currencyCode: "JPY", pricePaid: 1000 }),
        creds,
      );
      const ticket = pass.eventTicket as TicketFields;
      const priceField = ticket.auxiliaryFields.find((f) => f.key === "price");
      expect(priceField!.value).toBe(1000);
      expect(priceField!.currencyCode).toBe("JPY");
    });

    test("converts price using currency decimal places for GBP (2 decimals)", () => {
      const pass = generatePassJson(
        makePassData({ currencyCode: "GBP", pricePaid: 2500 }),
        creds,
      );
      const ticket = pass.eventTicket as TicketFields;
      const priceField = ticket.auxiliaryFields.find((f) => f.key === "price");
      expect(priceField!.value).toBe(25);
      expect(priceField!.currencyCode).toBe("GBP");
    });
  });
});
