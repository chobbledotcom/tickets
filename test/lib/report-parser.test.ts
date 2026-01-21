import { describe, expect, test } from "bun:test";
import {
  extractDeviceInfo,
  extractDimensions,
  extractInspectionSections,
  extractIntroFields,
  extractNotes,
  extractReportDetails,
  extractUserLimits,
  fetchAllReportDetails,
  fetchReport,
  fetchReportDetails,
  parseReportPage,
} from "../../src/lib/report-parser.ts";
import { minimalReportHtml, reportPageHtml } from "../fixtures/index.ts";

describe("extractIntroFields", () => {
  test("extracts report ID from header", () => {
    const result = extractIntroFields(reportPageHtml);
    expect(result.reportId).toBe("431119-v1");
  });

  test("extracts ID from intro table", () => {
    const result = extractIntroFields(reportPageHtml);
    expect(result.id).toBe("431119-v1");
  });

  test("extracts validity dates", () => {
    const result = extractIntroFields(reportPageHtml);
    expect(result.validFrom).toBe("04 November 2025");
    expect(result.expiryDate).toBe("03 November 2026");
  });

  test("extracts status with class", () => {
    const result = extractIntroFields(reportPageHtml);
    expect(result.status).toBe("Pass");
    expect(result.statusClass).toBe("green");
  });

  test("extracts inspection body", () => {
    const result = extractIntroFields(reportPageHtml);
    expect(result.inspectionBody).toBe("Andy J Leisure Ltd");
  });

  test("extracts tag number", () => {
    const result = extractIntroFields(reportPageHtml);
    expect(result.tagNo).toBe("40000");
  });

  test("extracts device type", () => {
    const result = extractIntroFields(reportPageHtml);
    expect(result.deviceType).toBe("Bounce/Slide Combo");
  });

  test("extracts serial number", () => {
    const result = extractIntroFields(reportPageHtml);
    expect(result.serialNumber).toBe("P31206");
  });

  test("extracts image URL", () => {
    const result = extractIntroFields(reportPageHtml);
    expect(result.imageUrl).toContain("hub.pipa.org.uk/content-files");
    expect(result.imageUrl).not.toContain("&amp;");
  });

  test("returns empty object for invalid HTML", () => {
    const result = extractIntroFields("<html><body>Not a report</body></html>");
    expect(Object.keys(result).length).toBe(0);
  });

  test("handles badge with invalid class format", () => {
    const html = `
      <table>
        <tr>
          <td><div class="label">Status:</div></td>
          <td><div class="badge">Pass</div></td>
        </tr>
      </table>
    `;
    const result = extractIntroFields(html);
    expect(result.status).toBeUndefined();
    expect(result.statusClass).toBeUndefined();
  });
});

describe("extractReportDetails", () => {
  test("extracts creation date", () => {
    const result = extractReportDetails(reportPageHtml);
    expect(result.creationDate).toBe("04/11/2025");
  });

  test("extracts inspection date", () => {
    const result = extractReportDetails(reportPageHtml);
    expect(result.inspectionDate).toBe("04/11/2025");
  });

  test("extracts place of inspection", () => {
    const result = extractReportDetails(reportPageHtml);
    expect(result.placeOfInspection).toBe("Tarbock Green (AJL)");
  });

  test("extracts inspector name", () => {
    const result = extractReportDetails(reportPageHtml);
    expect(result.inspector).toBe("4: Matthew Hardwick");
  });

  test("extracts structure version", () => {
    const result = extractReportDetails(reportPageHtml);
    expect(result.structureVersion).toBe("202505");
  });

  test("extracts indoor use only flag", () => {
    const result = extractReportDetails(reportPageHtml);
    expect(result.indoorUseOnly).toBe("No");
  });

  test("returns empty object for invalid HTML", () => {
    const result = extractReportDetails(
      "<html><body>Not a report</body></html>",
    );
    expect(Object.keys(result).length).toBe(0);
  });
});

describe("extractDeviceInfo", () => {
  test("extracts PIPA reference number", () => {
    const result = extractDeviceInfo(reportPageHtml);
    expect(result.pipaReferenceNumber).toBe("40000");
  });

  test("extracts tag number", () => {
    const result = extractDeviceInfo(reportPageHtml);
    expect(result.tagNumber).toBe("40000");
  });

  test("extracts device type", () => {
    const result = extractDeviceInfo(reportPageHtml);
    expect(result.type).toBe("Bounce/Slide Combo");
  });

  test("extracts device name", () => {
    const result = extractDeviceInfo(reportPageHtml);
    expect(result.name).toBe("BOX JUMP PARTY SLIDE");
  });

  test("extracts manufacturer", () => {
    const result = extractDeviceInfo(reportPageHtml);
    expect(result.manufacturer).toBe("Airquee Ltd");
  });

  test("extracts serial number", () => {
    const result = extractDeviceInfo(reportPageHtml);
    expect(result.deviceSerialNumber).toBe("P31206");
  });

  test("extracts date manufactured", () => {
    const result = extractDeviceInfo(reportPageHtml);
    expect(result.dateManufactured).toBe("Unknown");
  });

  test("extracts operation manual status", () => {
    const result = extractDeviceInfo(reportPageHtml);
    expect(result.operationManualPresent).toEqual({
      statusClass: "green",
      status: "Pass",
    });
  });

  test("returns empty object for invalid HTML", () => {
    const result = extractDeviceInfo("<html><body>Not a report</body></html>");
    expect(Object.keys(result).length).toBe(0);
  });

  test("handles Device header outside of table element", () => {
    const html = `
      <div>
        <th colspan="4">Device</th>
      </div>
      <table>
        <tr>
          <td><div class="label">PIPA Reference Number:</div></td>
          <td><div class="detail">12345</div></td>
        </tr>
      </table>
    `;
    const result = extractDeviceInfo(html);
    expect(result.pipaReferenceNumber).toBe("12345");
  });
});

describe("extractDimensions", () => {
  test("extracts length", () => {
    const result = extractDimensions(reportPageHtml);
    expect(result.length).toBe("5.5m");
  });

  test("extracts width", () => {
    const result = extractDimensions(reportPageHtml);
    expect(result.width).toBe("3.9m");
  });

  test("extracts height", () => {
    const result = extractDimensions(reportPageHtml);
    expect(result.height).toBe("3m");
  });

  test("returns empty object for invalid HTML", () => {
    const result = extractDimensions("<html><body>Not a report</body></html>");
    expect(Object.keys(result).length).toBe(0);
  });
});

describe("extractUserLimits", () => {
  test("extracts user limits by height", () => {
    const result = extractUserLimits(reportPageHtml);
    expect(result.upTo1_0m).toBe(7);
    expect(result.upTo1_2m).toBe(6);
    expect(result.upTo1_5m).toBe(5);
    expect(result.upTo1_8m).toBe(4);
  });

  test("extracts custom max height", () => {
    const result = extractUserLimits(reportPageHtml);
    expect(result.customMaxHeight).toBe("2.0m");
  });

  test("returns empty object for invalid HTML", () => {
    const result = extractUserLimits("<html><body>Not a report</body></html>");
    expect(Object.keys(result).length).toBe(0);
  });
});

describe("extractNotes", () => {
  test("extracts additional notes with newline conversion", () => {
    const result = extractNotes(reportPageHtml);
    expect(result.additionalNotes).toContain("PLEASE USE MATS");
    expect(result.additionalNotes).toContain("\n");
  });

  test("extracts risk assessment notes", () => {
    const result = extractNotes(reportPageHtml);
    expect(result.riskAssessmentNotes).toBe("Check daily");
  });

  test("extracts repairs needed", () => {
    const result = extractNotes(reportPageHtml);
    expect(result.repairsNeeded).toBe("None");
  });

  test("extracts advisory items", () => {
    const result = extractNotes(reportPageHtml);
    expect(result.advisoryItems).toBe("Monitor seams");
  });

  test("returns empty object for invalid HTML", () => {
    const result = extractNotes("<html><body>Not a report</body></html>");
    expect(Object.keys(result).length).toBe(0);
  });
});

describe("extractInspectionSections", () => {
  test("extracts structure section with fields", () => {
    const result = extractInspectionSections(reportPageHtml);
    expect(result.structure).toBeDefined();
    expect(result.structure?.length).toBeGreaterThan(0);
  });

  test("extracts field with status badge", () => {
    const result = extractInspectionSections(reportPageHtml);
    const troughDepth = result.structure?.find(
      (f) => f.label === "Trough Depth",
    );
    expect(troughDepth).toBeDefined();
    expect(troughDepth?.status).toBe("Pass");
    expect(troughDepth?.statusClass).toBe("green");
    expect(troughDepth?.value).toBe("0.15m");
    expect(troughDepth?.notes).toBe("10/45s 16/53");
  });

  test("extracts materials section", () => {
    const result = extractInspectionSections(reportPageHtml);
    expect(result.materials).toBeDefined();
    expect(result.materials?.length).toBeGreaterThan(0);
  });

  test("excludes Report Details and Device sections", () => {
    const result = extractInspectionSections(reportPageHtml);
    expect(result.reportDetails).toBeUndefined();
    expect(result.device).toBeUndefined();
  });

  test("returns empty object for invalid HTML", () => {
    const result = extractInspectionSections(
      "<html><body>Not a report</body></html>",
    );
    expect(Object.keys(result).length).toBe(0);
  });

  test("converts multi-word section names to camelCase", () => {
    const html = `
      <table class="table">
        <thead>
          <tr><th colspan="4">Area & surround</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><div class="label">Play Area m²:</div></td>
            <td><div class="detail">25</div></td>
            <td><div class="text"></div></td>
          </tr>
        </tbody>
      </table>
    `;
    const result = extractInspectionSections(html);
    expect(result.areaSurround).toBeDefined();
    expect(result.areaSurround?.[0]?.label).toBe("Play Area m²");
  });

  test("handles th[colspan] outside of table element", () => {
    const html = `
      <div>
        <th colspan="4">Orphan Header</th>
      </div>
      <table class="table">
        <thead>
          <tr><th colspan="4">Valid Section</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><div class="label">Test Field:</div></td>
            <td><div class="detail">Value</div></td>
          </tr>
        </tbody>
      </table>
    `;
    const result = extractInspectionSections(html);
    expect(result.validSection).toBeDefined();
    expect(result.orphanHeader).toBeUndefined();
  });
});

describe("parseReportPage", () => {
  test("parses complete report successfully", () => {
    const result = parseReportPage(reportPageHtml);

    expect(result.found).toBe(true);
    expect(result.id).toBe("431119-v1");
    expect(result.status).toBe("Pass");
    expect(result.tagNo).toBe("40000");
    expect(result.fetchedAt).toBeDefined();
  });

  test("includes all sections", () => {
    const result = parseReportPage(reportPageHtml);

    expect(result.reportDetails).toBeDefined();
    expect(result.device).toBeDefined();
    expect(result.dimensions).toBeDefined();
    expect(result.userLimits).toBeDefined();
    expect(result.notes).toBeDefined();
    expect(result.inspectionSections).toBeDefined();
  });

  test("returns found: false for non-report page", () => {
    const result = parseReportPage("<html><body>Not a report</body></html>");
    expect(result.found).toBe(false);
  });

  test("returns found: false for empty HTML", () => {
    const result = parseReportPage("");
    expect(result.found).toBe(false);
  });
});

describe("fetchReport", () => {
  test("returns error for invalid URL", async () => {
    const result = await fetchReport("https://example.com/report");
    expect(result.found).toBe(false);
    expect(result.error).toBe("Invalid report URL");
  });

  test("returns error for null URL", async () => {
    const result = await fetchReport(null);
    expect(result.found).toBe(false);
    expect(result.error).toBe("Invalid report URL");
  });

  test("returns error for empty URL", async () => {
    const result = await fetchReport("");
    expect(result.found).toBe(false);
    expect(result.error).toBe("Invalid report URL");
  });

  test("follows redirect and parses PDF", async () => {
    let callCount = 0;
    const mockFetch = (url: string) => {
      callCount++;
      if (callCount === 1) {
        // First call - return redirect
        return Promise.resolve({
          status: 301,
          headers: new Map([
            ["location", "https://hub.pipa.org.uk/download/file.pdf"],
          ]),
        });
      }
      // Second call - return PDF content (empty buffer triggers parse error)
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/pdf"]]),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    };

    const result = await fetchReport(
      "https://hub.pipa.org.uk/public/reports/report/abc",
      { fetcher: mockFetch as unknown as typeof fetch },
    );

    expect(callCount).toBe(2);
    // With empty PDF buffer, parsing fails but redirect was followed
    expect(result.isPdf).toBe(true);
    expect(result.error).toContain("PDF parsing failed");
  });

  test("handles HTTP error", async () => {
    const mockFetch = () =>
      Promise.resolve({
        ok: false,
        status: 404,
      });

    const result = await fetchReport(
      "https://hub.pipa.org.uk/public/reports/report/abc",
      { fetcher: mockFetch as unknown as typeof fetch },
    );

    expect(result.found).toBe(false);
    expect(result.error).toBe("Report fetch error: 404");
  });

  test("handles PDF parsing errors gracefully", async () => {
    // When PDF content is detected but parsing fails, return error response
    const mockFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/pdf"]]),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });

    const result = await fetchReport(
      "https://hub.pipa.org.uk/public/reports/report/abc",
      { fetcher: mockFetch as unknown as typeof fetch },
    );

    expect(result.found).toBe(false);
    expect(result.isPdf).toBe(true);
    expect(result.error).toContain("PDF parsing failed");
  });

  test("parses valid HTML response", async () => {
    const mockFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve(reportPageHtml),
      });

    const result = await fetchReport(
      "https://hub.pipa.org.uk/public/reports/report/abc",
      { fetcher: mockFetch as unknown as typeof fetch },
    );

    expect(result.found).toBe(true);
    expect(result.id).toBe("431119-v1");
  });
});

describe("fetchReportDetails", () => {
  test("returns error when report has no URL", async () => {
    const result = await fetchReportDetails({ date: "2025-01-01" } as never);

    expect(result.details).toBeNull();
    expect(result.detailsError).toBe("No report URL");
  });

  test("returns error when report is null", async () => {
    const result = await fetchReportDetails(null);

    expect(result.details).toBeNull();
    expect(result.detailsError).toBe("No report URL");
  });

  test("fetches and parses report details", async () => {
    const mockFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve(minimalReportHtml),
      });

    const report = {
      url: "https://hub.pipa.org.uk/public/reports/report/abc",
      date: "04 Nov 2025",
      statusClass: "green",
      reportNo: "123",
      inspectionBody: "Test",
      status: "Pass",
    };
    const result = await fetchReportDetails(report, {
      fetcher: mockFetch as unknown as typeof fetch,
    });

    expect(result.date).toBe("04 Nov 2025");
    expect(result.details).toBeDefined();
    expect(result.details?.found).toBe(true);
  });

  test("returns error when fetch fails", async () => {
    const mockFetch = () =>
      Promise.resolve({
        ok: false,
        status: 404,
      });

    const report = {
      url: "https://hub.pipa.org.uk/public/reports/report/abc",
      statusClass: "green",
      date: "2025-01-01",
      reportNo: "123",
      inspectionBody: "Test",
      status: "Pass",
    };
    const result = await fetchReportDetails(report, {
      fetcher: mockFetch as unknown as typeof fetch,
    });

    expect(result.details).toBeNull();
    expect(result.detailsError).toBe("Report fetch error: 404");
  });
});

describe("fetchAllReportDetails", () => {
  test("returns unchanged data when not found", async () => {
    const tagData = { found: false, error: "Not found" };
    const result = await fetchAllReportDetails(tagData);

    expect(result).toEqual(tagData);
  });

  test("returns unchanged data when no annual reports", async () => {
    const tagData = { found: true, tagId: "40000", annualReports: [] };
    const result = await fetchAllReportDetails(tagData);

    expect(result).toEqual(tagData);
  });

  test("returns unchanged data when null", async () => {
    const result = await fetchAllReportDetails(null);

    expect(result).toBeNull();
  });

  test("fetches details for all annual reports", async () => {
    const mockFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve(minimalReportHtml),
      });

    const tagData = {
      found: true,
      tagId: "40000",
      annualReports: [
        {
          url: "https://hub.pipa.org.uk/public/reports/report/abc",
          statusClass: "green",
          date: "2025-01-01",
          reportNo: "123",
          inspectionBody: "Test",
          status: "Pass",
        },
        {
          url: "https://hub.pipa.org.uk/public/reports/report/def",
          statusClass: "green",
          date: "2024-01-01",
          reportNo: "456",
          inspectionBody: "Test",
          status: "Pass",
        },
      ],
    };

    const result = await fetchAllReportDetails(tagData, {
      fetcher: mockFetch as unknown as typeof fetch,
    });

    expect(result.annualReports).toHaveLength(2);
    expect(result.annualReports?.[0]?.details).toBeDefined();
    expect(result.annualReports?.[1]?.details).toBeDefined();
  });
});
