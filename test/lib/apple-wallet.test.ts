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
  padAuthToken,
  type SigningCredentials,
  sha1Hex,
  signManifest,
  trimAuthToken,
} from "#shared/apple-wallet.ts";
import { WALLET_ICONS } from "#shared/wallet-icons.ts";
import { generateTestCerts } from "#test-utils/crypto.ts";

/** Type for eventTicket field groups in pass.json */
type TicketFields = {
  primaryFields: Array<Record<string, unknown>>;
  secondaryFields: Array<Record<string, unknown>>;
  auxiliaryFields: Array<Record<string, unknown>>;
  backFields: Array<Record<string, unknown>>;
};

const makePassData = (overrides: Partial<PassData> = {}): PassData => ({
  attendeeDate: null,
  checkinUrl: "https://example.com/checkin/ABC123",
  currencyCode: "GBP",
  description: "Ticket for Summer Concert",
  eventDate: "2026-06-15T19:00:00Z",
  eventLocation: "Town Hall",
  eventName: "Summer Concert",
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

    test("includes all required top-level fields and barcode", () => {
      const pass = extractPassJson(buildPkpass(makePassData(), creds));

      expect(pass.formatVersion).toBe(1);
      expect(pass.passTypeIdentifier).toBe("pass.com.test.tickets");
      expect(pass.teamIdentifier).toBe("TESTTEAM01");
      expect(pass.serialNumber).toBe("ABC123");
      expect(pass.organizationName).toBe("Test Platform");
      expect(pass.description).toBe("Ticket for Summer Concert");

      const barcodes = pass.barcodes as Array<Record<string, string>>;
      expect(barcodes).toHaveLength(1);
      expect(barcodes[0]!.format).toBe("PKBarcodeFormatQR");
      expect(barcodes[0]!.message).toBe("https://example.com/checkin/ABC123");
      expect(barcodes[0]!.messageEncoding).toBe("iso-8859-1");

      const ticket = pass.eventTicket as TicketFields;
      expect(ticket.primaryFields[0]!.value).toBe("Summer Concert");

      const dateField = ticket.secondaryFields.find(
        (f: Record<string, unknown>) => f.key === "date",
      );
      expect(dateField).toBeDefined();
      expect(dateField!.value).toBe("2026-06-15T19:00:00Z");

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

    test("omits date, location, qty, and price when data is empty or default", () => {
      const pass = extractPassJson(
        buildPkpass(
          makePassData({
            eventDate: "",
            eventLocation: "",
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

    test("includes quantity, price, and booking date when present", () => {
      const pass = extractPassJson(
        buildPkpass(
          makePassData({
            attendeeDate: "2026-06-15",
            currencyCode: "EUR",
            pricePaid: 2500,
            quantity: 3,
          }),
          creds,
        ),
      );
      const ticket = pass.eventTicket as TicketFields;

      const qtyField = ticket.auxiliaryFields.find(
        (f: Record<string, unknown>) => f.key === "qty",
      );
      expect(qtyField).toBeDefined();
      expect(qtyField!.value).toBe(3);

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

    test("uses custom colors when provided", () => {
      const pass = extractPassJson(
        buildPkpass(
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
      const manifest = createManifest({ "icon.png": b, "pass.json": a });
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
