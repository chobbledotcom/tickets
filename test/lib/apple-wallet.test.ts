import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { unzipSync } from "fflate";
import forge from "node-forge";
import {
  buildPkpass,
  createManifest,
  generatePassJson,
  isValidPemCertificate,
  isValidPemPrivateKey,
  type PassData,
  type SigningCredentials,
  sha1Hex,
  signManifest,
} from "#lib/apple-wallet.ts";
import { WALLET_ICONS } from "#lib/wallet-icons.ts";
import { generateTestCerts } from "#test-utils";

/** Type for eventTicket field groups in pass.json */
type TicketFields = {
  primaryFields: Array<Record<string, unknown>>;
  secondaryFields: Array<Record<string, unknown>>;
  auxiliaryFields: Array<Record<string, unknown>>;
  backFields: Array<Record<string, unknown>>;
};

const makePassData = (overrides: Partial<PassData> = {}): PassData => ({
  serialNumber: "ABC123",
  organizationName: "Test Platform",
  description: "Ticket for Summer Concert",
  eventName: "Summer Concert",
  eventDate: "2026-06-15T19:00:00Z",
  eventLocation: "Town Hall",
  attendeeDate: null,
  quantity: 1,
  pricePaid: 0,
  currencyCode: "GBP",
  checkinUrl: "https://example.com/checkin/ABC123",
  webServiceURL: "https://example.com",
  ...overrides,
});

describe("apple-wallet", () => {
  // Certs are cached in generateTestCerts — no per-test RSA keygen
  const creds: SigningCredentials = generateTestCerts();

  describe("generatePassJson", () => {
    test("includes required top-level fields", () => {
      const pass = generatePassJson(makePassData(), creds);
      expect(pass.formatVersion).toBe(1);
      expect(pass.passTypeIdentifier).toBe("pass.com.test.tickets");
      expect(pass.teamIdentifier).toBe("TESTTEAM01");
      expect(pass.serialNumber).toBe("ABC123");
      expect(pass.organizationName).toBe("Test Platform");
      expect(pass.description).toBe("Ticket for Summer Concert");
    });

    test("includes barcode with QR format", () => {
      const pass = generatePassJson(makePassData(), creds);
      const barcodes = pass.barcodes as Array<Record<string, string>>;
      expect(barcodes).toHaveLength(1);
      expect(barcodes[0]!.format).toBe("PKBarcodeFormatQR");
      expect(barcodes[0]!.message).toBe("https://example.com/checkin/ABC123");
      expect(barcodes[0]!.messageEncoding).toBe("iso-8859-1");
    });

    test("includes event name in primary fields", () => {
      const pass = generatePassJson(makePassData(), creds);
      const ticket = pass.eventTicket as TicketFields;
      expect(ticket.primaryFields[0]!.value).toBe("Summer Concert");
    });

    test("includes event date in secondary fields", () => {
      const pass = generatePassJson(makePassData(), creds);
      const ticket = pass.eventTicket as TicketFields;
      const dateField = ticket.secondaryFields.find((f) => f.key === "date");
      expect(dateField).toBeDefined();
      expect(dateField!.value).toBe("2026-06-15T19:00:00Z");
    });

    test("includes location in secondary fields", () => {
      const pass = generatePassJson(makePassData(), creds);
      const ticket = pass.eventTicket as TicketFields;
      const locationField = ticket.secondaryFields.find(
        (f) => f.key === "location",
      );
      expect(locationField).toBeDefined();
      expect(locationField!.value).toBe("Town Hall");
    });

    test("omits date when eventDate is empty", () => {
      const pass = generatePassJson(makePassData({ eventDate: "" }), creds);
      const ticket = pass.eventTicket as TicketFields;
      expect(
        ticket.secondaryFields.find((f) => f.key === "date"),
      ).toBeUndefined();
      expect(pass.relevantDate).toBeUndefined();
    });

    test("omits location when eventLocation is empty", () => {
      const pass = generatePassJson(makePassData({ eventLocation: "" }), creds);
      const ticket = pass.eventTicket as TicketFields;
      expect(
        ticket.secondaryFields.find((f) => f.key === "location"),
      ).toBeUndefined();
    });

    test("includes quantity when greater than 1", () => {
      const pass = generatePassJson(makePassData({ quantity: 3 }), creds);
      const ticket = pass.eventTicket as TicketFields;
      const qtyField = ticket.auxiliaryFields.find((f) => f.key === "qty");
      expect(qtyField).toBeDefined();
      expect(qtyField!.value).toBe(3);
    });

    test("omits quantity when equal to 1", () => {
      const pass = generatePassJson(makePassData({ quantity: 1 }), creds);
      const ticket = pass.eventTicket as TicketFields;
      expect(
        ticket.auxiliaryFields.find((f) => f.key === "qty"),
      ).toBeUndefined();
    });

    test("includes price when greater than 0", () => {
      const pass = generatePassJson(
        makePassData({ pricePaid: 2500, currencyCode: "EUR" }),
        creds,
      );
      const ticket = pass.eventTicket as TicketFields;
      const priceField = ticket.auxiliaryFields.find((f) => f.key === "price");
      expect(priceField).toBeDefined();
      expect(priceField!.value).toBe(25);
      expect(priceField!.currencyCode).toBe("EUR");
    });

    test("omits price when zero", () => {
      const pass = generatePassJson(makePassData({ pricePaid: 0 }), creds);
      const ticket = pass.eventTicket as TicketFields;
      expect(
        ticket.auxiliaryFields.find((f) => f.key === "price"),
      ).toBeUndefined();
    });

    test("includes attendee booking date when present", () => {
      const pass = generatePassJson(
        makePassData({ attendeeDate: "2026-06-15" }),
        creds,
      );
      const ticket = pass.eventTicket as TicketFields;
      const dateField = ticket.auxiliaryFields.find(
        (f) => f.key === "booking-date",
      );
      expect(dateField).toBeDefined();
      expect(dateField!.value).toBe("2026-06-15");
    });

    test("sets relevantDate from eventDate", () => {
      const pass = generatePassJson(makePassData(), creds);
      expect(pass.relevantDate).toBe("2026-06-15T19:00:00Z");
    });

    test("uses default colors when not specified", () => {
      const pass = generatePassJson(makePassData(), creds);
      expect(pass.foregroundColor).toBe("rgb(0, 0, 0)");
      expect(pass.backgroundColor).toBe("rgb(255, 255, 255)");
      expect(pass.labelColor).toBe("rgb(100, 100, 100)");
    });

    test("uses custom colors when provided", () => {
      const pass = generatePassJson(
        makePassData({
          foregroundColor: "rgb(255, 0, 0)",
          backgroundColor: "rgb(0, 0, 255)",
          labelColor: "rgb(0, 255, 0)",
        }),
        creds,
      );
      expect(pass.foregroundColor).toBe("rgb(255, 0, 0)");
      expect(pass.backgroundColor).toBe("rgb(0, 0, 255)");
      expect(pass.labelColor).toBe("rgb(0, 255, 0)");
    });

    test("includes webServiceURL and authenticationToken for auto-updates", () => {
      const pass = generatePassJson(makePassData(), creds);
      expect(pass.webServiceURL).toBe("https://example.com");
      expect(pass.authenticationToken).toBe("ABC123");
    });
  });

  describe("sha1Hex", () => {
    test("computes correct SHA-1 hash", () => {
      const data = new TextEncoder().encode("hello");
      const hash = sha1Hex(data);
      expect(hash).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    });

    test("produces different hashes for different data", () => {
      const a = sha1Hex(new TextEncoder().encode("abc"));
      const b = sha1Hex(new TextEncoder().encode("xyz"));
      expect(a).not.toBe(b);
    });
  });

  describe("createManifest", () => {
    test("produces JSON mapping filenames to SHA-1 hashes", () => {
      const data = new TextEncoder().encode('{"test":true}');
      const manifest = createManifest({ "pass.json": data });
      const parsed = JSON.parse(manifest);
      expect(parsed["pass.json"]).toBe(sha1Hex(data));
    });

    test("includes all provided files", () => {
      const a = new TextEncoder().encode("aaa");
      const b = new TextEncoder().encode("bbb");
      const manifest = createManifest({ "pass.json": a, "icon.png": b });
      const parsed = JSON.parse(manifest);
      expect(Object.keys(parsed)).toHaveLength(2);
      expect(parsed["pass.json"]).toBeDefined();
      expect(parsed["icon.png"]).toBeDefined();
    });
  });

  describe("signManifest", () => {
    test("produces valid DER-encoded PKCS#7 signatures", () => {
      const manifest1 = '{"pass.json":"abc123"}';
      const manifest2 = '{"pass.json":"def456"}';
      const sig1 = signManifest(
        manifest1,
        creds.signingCert,
        creds.signingKey,
        creds.wwdrCert,
      );
      const sig2 = signManifest(
        manifest2,
        creds.signingCert,
        creds.signingKey,
        creds.wwdrCert,
      );

      // Non-empty Uint8Array
      expect(sig1).toBeInstanceOf(Uint8Array);
      expect(sig1.length).toBeGreaterThan(0);
      expect(sig2.length).toBeGreaterThan(0);

      // Parseable as ASN.1
      const der = forge.util.binary.raw.encode(sig1);
      const asn1 = forge.asn1.fromDer(der);
      expect(asn1).toBeDefined();
    });
  });

  describe("buildPkpass", () => {
    test("produces a valid ZIP with pass.json, icons, and manifest hashes", () => {
      const data = makePassData();
      const pkpass = buildPkpass(data, creds);
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
      expect(manifest["pass.json"]).toBe(sha1Hex(files["pass.json"]!));
      expect(manifest["icon.png"]).toBe(sha1Hex(files["icon.png"]!));
      expect(manifest["icon@2x.png"]).toBe(sha1Hex(files["icon@2x.png"]!));
      expect(manifest["icon@3x.png"]).toBe(sha1Hex(files["icon@3x.png"]!));
    });

    test("produces different pkpass for different serial numbers", () => {
      const a = buildPkpass(makePassData({ serialNumber: "AAA" }), creds);
      const b = buildPkpass(makePassData({ serialNumber: "BBB" }), creds);
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

  describe("isValidPemCertificate", () => {
    test("returns true for a valid PEM certificate", () => {
      expect(isValidPemCertificate(creds.signingCert)).toBe(true);
    });

    test("returns false for a private key PEM", () => {
      expect(isValidPemCertificate(creds.signingKey)).toBe(false);
    });

    test("returns false for garbage input", () => {
      expect(isValidPemCertificate("not a certificate")).toBe(false);
    });
  });

  describe("isValidPemPrivateKey", () => {
    test("returns true for a valid PEM private key", () => {
      expect(isValidPemPrivateKey(creds.signingKey)).toBe(true);
    });

    test("returns false for a certificate PEM", () => {
      expect(isValidPemPrivateKey(creds.signingCert)).toBe(false);
    });

    test("returns false for garbage input", () => {
      expect(isValidPemPrivateKey("not a key")).toBe(false);
    });
  });

  describe("currency-aware price formatting", () => {
    test("converts price using currency decimal places for JPY (0 decimals)", () => {
      const pass = generatePassJson(
        makePassData({ pricePaid: 1000, currencyCode: "JPY" }),
        creds,
      );
      const ticket = pass.eventTicket as TicketFields;
      const priceField = ticket.auxiliaryFields.find((f) => f.key === "price");
      expect(priceField!.value).toBe(1000);
      expect(priceField!.currencyCode).toBe("JPY");
    });

    test("converts price using currency decimal places for GBP (2 decimals)", () => {
      const pass = generatePassJson(
        makePassData({ pricePaid: 2500, currencyCode: "GBP" }),
        creds,
      );
      const ticket = pass.eventTicket as TicketFields;
      const priceField = ticket.auxiliaryFields.find((f) => f.key === "price");
      expect(priceField!.value).toBe(25);
      expect(priceField!.currencyCode).toBe("GBP");
    });
  });
});
