import { describe, expect, test } from "bun:test";
import { parsePdfBuffer, parsePdfText } from "../../src/lib/pdf-parser.ts";
import { searchTag } from "../../src/lib/tag-parser.ts";

const samplePdfText = `Certificate of Inspection
PIPA Device Reference Number: 40000 	| Tag Number: 40000 	| Report: 431119-v1
Pass Inspection Valid From:
04 November 2025
Expiry Date:
03 November 2026
I confirm that this inflatable Bounce and Slide combo device has been
inspected in accordance with the PIPA scheme rules, and where it is
applicable, it meets the requirements of BS EN 14960. All details
contained within this inspection report are a true representation of
what I found and observed during my inspection process.
Inspector Name: 	Matthew Hardwick
Inspection Body: 	Andy J Leisure Ltd
Inspection Report ID: 	431119-v1
Signature:
Device Details
Manufacturer: 	Airquee Ltd
Device Type: 	Bounce/Slide Combo
Manufactured Date: 	Unknown
Device Description:
Device Disclamer: 	I confirm that this inflatable Bounce
and Slide combo device has been
inspected in accordance with the
PIPA scheme rules, and where it is
applicable, it meets the
requirements of BS EN 14960. All
details contained within this
inspection report are a true
representation of what I found and
observed during my inspection
process.
Dimensions (L x W x H): 	5.5m x 3.9m x 3m
Tested for Indoor Use Only? 	No
View Report
Scan the QR Code
to access the full
report
The UK's Inflatable Play Inspection Scheme 	© 2026 The PIPA Testing Scheme Ltd. All Rights Reserved

-- 1 of 1 --`;

describe("parsePdfText", () => {
  test("extracts report ID", () => {
    const result = parsePdfText(samplePdfText);
    expect(result.found).toBe(true);
    expect(result.reportId).toBe("431119-v1");
  });

  test("extracts PIPA reference number and tag number", () => {
    const result = parsePdfText(samplePdfText);
    expect(result.tagNo).toBe("40000");
    expect(result.device?.pipaReferenceNumber).toBe("40000");
    expect(result.device?.tagNumber).toBe("40000");
  });

  test("extracts status as Pass with green class", () => {
    const result = parsePdfText(samplePdfText);
    expect(result.status).toBe("Pass");
    expect(result.statusClass).toBe("green");
  });

  test("extracts validity dates", () => {
    const result = parsePdfText(samplePdfText);
    expect(result.validFrom).toBe("04 November 2025");
    expect(result.expiryDate).toBe("03 November 2026");
  });

  test("extracts inspector and inspection body", () => {
    const result = parsePdfText(samplePdfText);
    expect(result.reportDetails?.inspector).toBe("Matthew Hardwick");
    expect(result.inspectionBody).toBe("Andy J Leisure Ltd");
  });

  test("extracts device info", () => {
    const result = parsePdfText(samplePdfText);
    expect(result.device?.manufacturer).toBe("Airquee Ltd");
    expect(result.device?.type).toBe("Bounce/Slide Combo");
    expect(result.device?.dateManufactured).toBe("Unknown");
    expect(result.deviceType).toBe("Bounce/Slide Combo");
  });

  test("extracts dimensions", () => {
    const result = parsePdfText(samplePdfText);
    expect(result.dimensions?.length).toBe("5.5m");
    expect(result.dimensions?.width).toBe("3.9m");
    expect(result.dimensions?.height).toBe("3m");
  });

  test("extracts indoor use only flag", () => {
    const result = parsePdfText(samplePdfText);
    expect(result.reportDetails?.indoorUseOnly).toBe("No");
  });

  test("sets isPdf flag", () => {
    const result = parsePdfText(samplePdfText);
    expect(result.isPdf).toBe(true);
  });

  test("sets fetchedAt timestamp", () => {
    const result = parsePdfText(samplePdfText);
    expect(result.fetchedAt).toBeDefined();
    expect(new Date(result.fetchedAt as string).getTime()).toBeGreaterThan(0);
  });

  test("returns not found for empty text", () => {
    const result = parsePdfText("");
    expect(result.found).toBe(false);
    expect(result.error).toBe("Empty PDF text content");
  });

  test("handles Fail status with red class", () => {
    const failText = samplePdfText.replace(
      "Pass Inspection Valid From:",
      "Fail Inspection Valid From:",
    );
    const result = parsePdfText(failText);
    expect(result.status).toBe("Fail");
    expect(result.statusClass).toBe("red");
  });

  test("handles missing status with yellow class", () => {
    const noStatusText = samplePdfText.replace(
      "Pass Inspection Valid From:",
      "Inspection Valid From:",
    );
    const result = parsePdfText(noStatusText);
    expect(result.statusClass).toBe("unknown");
  });

  test("handles dimensions without m suffix", () => {
    const text = "Dimensions (L x W x H): 5 x 4 x 3";
    const result = parsePdfText(text);
    expect(result.dimensions?.length).toBe("5m");
    expect(result.dimensions?.width).toBe("4m");
    expect(result.dimensions?.height).toBe("3m");
  });

  test("handles missing dimensions", () => {
    const text = "Some text without dimensions";
    const result = parsePdfText(text);
    expect(result.dimensions).toBeUndefined();
  });

  test("extracts report ID from Inspection Report ID field", () => {
    const text = "Inspection Report ID: 123456-v2";
    const result = parsePdfText(text);
    expect(result.reportId).toBe("123456-v2");
  });

  test("handles Yes for indoor use only", () => {
    const yesText = samplePdfText.replace(
      "Tested for Indoor Use Only? 	No",
      "Tested for Indoor Use Only? Yes",
    );
    const result = parsePdfText(yesText);
    expect(result.reportDetails?.indoorUseOnly).toBe("Yes");
  });

  test("returns minimal data when only basic info present", () => {
    const minimalText = "Some random text";
    const result = parsePdfText(minimalText);
    expect(result.found).toBe(true);
    expect(result.isPdf).toBe(true);
    expect(result.device).toBeUndefined();
    expect(result.reportDetails).toBeUndefined();
  });
});

describe("parsePdfBuffer", () => {
  test("throws meaningful error for invalid buffer", async () => {
    const invalidBuffer = new Uint8Array([0, 1, 2, 3]);
    await expect(parsePdfBuffer(invalidBuffer)).rejects.toThrow();
  });

  test(
    "parses real PDF from PIPA tag 40000",
    async () => {
      // First search for the tag to get the certificate URL
      const tagResult = await searchTag("40000");
      expect(tagResult.found).toBe(true);
      expect(tagResult.certificateUrl).toBeDefined();

      // Fetch the PDF
      const pdfResponse = await fetch(tagResult.certificateUrl as string);
      expect(pdfResponse.ok).toBe(true);
      const pdfBuffer = await pdfResponse.arrayBuffer();

      // Parse the PDF
      const result = await parsePdfBuffer(pdfBuffer);

      // Verify expected data for tag 40000
      expect(result.found).toBe(true);
      expect(result.isPdf).toBe(true);
      expect(result.tagNo).toBe("40000");
      expect(result.device?.pipaReferenceNumber).toBe("40000");
      expect(result.device?.tagNumber).toBe("40000");
      expect(result.device?.manufacturer).toBe("Airquee Ltd");
      expect(result.device?.type).toBe("Bounce/Slide Combo");
      expect(result.deviceType).toBe("Bounce/Slide Combo");
      expect(result.inspectionBody).toBe("Andy J Leisure Ltd");
      expect(result.reportDetails?.inspector).toBe("Matthew Hardwick");
      expect(result.dimensions?.length).toBe("5.5m");
      expect(result.dimensions?.width).toBe("3.9m");
      expect(result.dimensions?.height).toBe("3m");
    },
    { timeout: 30000 },
  );
});
