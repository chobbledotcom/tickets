import { describe, expect, test } from "bun:test";
import {
  extractAnnualReports,
  extractDetails,
  isAllNumbers,
  parseTagPage,
  searchTag,
} from "../../src/lib/tag-parser.ts";
import { tagPageHtml, tagPageNoReportsHtml } from "../fixtures/index.ts";

describe("isAllNumbers", () => {
  test("returns true for strings containing only digits", () => {
    expect(isAllNumbers("123")).toBe(true);
    expect(isAllNumbers("0")).toBe(true);
    expect(isAllNumbers("40000")).toBe(true);
    expect(isAllNumbers("9876543210")).toBe(true);
  });

  test("returns false for strings with non-digit characters", () => {
    expect(isAllNumbers("12a3")).toBe(false);
    expect(isAllNumbers("abc")).toBe(false);
    expect(isAllNumbers("12.34")).toBe(false);
    expect(isAllNumbers("12-34")).toBe(false);
    expect(isAllNumbers(" 123")).toBe(false);
    expect(isAllNumbers("123 ")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isAllNumbers("")).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(isAllNumbers(null)).toBe(false);
    expect(isAllNumbers(undefined)).toBe(false);
  });
});

describe("extractDetails", () => {
  test("extracts unit reference number", () => {
    const result = extractDetails(tagPageHtml);
    expect(result.unitReferenceNo).toBe("40000");
  });

  test("extracts type", () => {
    const result = extractDetails(tagPageHtml);
    expect(result.type).toBe("Bounce/Slide Combo");
  });

  test("extracts current operator", () => {
    const result = extractDetails(tagPageHtml);
    expect(result.currentOperator).toBe("Test Operator");
  });

  test("extracts certificate expiry date", () => {
    const result = extractDetails(tagPageHtml);
    expect(result.certificateExpiryDate).toBe("03 November 2026");
  });

  test("returns empty object for invalid HTML", () => {
    const result = extractDetails("<html><body>No details</body></html>");
    expect(Object.keys(result).length).toBe(0);
  });
});

describe("extractAnnualReports", () => {
  test("extracts annual reports from HTML", () => {
    const reports = extractAnnualReports(tagPageHtml);
    expect(reports.length).toBe(1);
    expect(reports[0]?.date).toBe("04 November 2025");
    expect(reports[0]?.reportNo).toBe("424365");
    expect(reports[0]?.inspectionBody).toBe("Test Inspector Ltd");
    expect(reports[0]?.status).toBe("Pass");
    expect(reports[0]?.statusClass).toBe("green");
  });

  test("returns empty array for HTML without reports", () => {
    const reports = extractAnnualReports(
      "<html><body>No reports</body></html>",
    );
    expect(reports.length).toBe(0);
  });
});

describe("parseTagPage", () => {
  test("parses a valid pass page correctly", () => {
    const result = parseTagPage(tagPageHtml, "40000");

    expect(result.found).toBe(true);
    expect(result.tagId).toBe("40000");
    expect(result.status).toBe("Pass");
    expect(result.statusClass).toBe("green");
    expect(result.unitReferenceNo).toBe("40000");
    expect(result.type).toBe("Bounce/Slide Combo");
    expect(result.currentOperator).toBe("Test Operator");
    expect(result.certificateExpiryDate).toBe("03 November 2026");
    expect(result.certificateUrl).toContain("hub.pipa.org.uk/download");
    expect(result.reportUrl).toContain("hub.pipa.org.uk/public/reports");
    expect(result.imageUrl).toContain("hub.pipa.org.uk/content-files");
    expect(result.fetchedAt).toBeDefined();
  });

  test("extracts annual reports", () => {
    const result = parseTagPage(tagPageHtml, "40000");

    expect(result.annualReports).toHaveLength(1);
    expect(result.annualReports?.[0]?.date).toBe("04 November 2025");
    expect(result.annualReports?.[0]?.reportNo).toBe("424365");
    expect(result.annualReports?.[0]?.inspectionBody).toBe(
      "Test Inspector Ltd",
    );
    expect(result.annualReports?.[0]?.status).toBe("Pass");
    expect(result.annualReports?.[0]?.statusClass).toBe("green");
  });

  test("returns found: false for invalid page", () => {
    const result = parseTagPage("<html><body>Not found</body></html>", "99999");

    expect(result.found).toBe(false);
    expect(result.tagId).toBe("99999");
  });

  test("parses tag page without annual reports", () => {
    const result = parseTagPage(tagPageNoReportsHtml, "12345");

    expect(result.found).toBe(true);
    expect(result.unitReferenceNo).toBe("12345");
    expect(result.annualReports).toHaveLength(0);
  });
});

describe("searchTag", () => {
  test("returns error for invalid tag ID", async () => {
    const result = await searchTag("abc");

    expect(result.found).toBe(false);
    expect(result.error).toContain("Invalid tag ID");
  });

  test("returns error for empty tag ID", async () => {
    const result = await searchTag("");

    expect(result.found).toBe(false);
    expect(result.error).toContain("Invalid tag ID");
  });

  test("returns error when search API fails", async () => {
    const mockFetch = () => Promise.resolve({ ok: false, status: 500 });

    const result = await searchTag("12345", {
      fetcher: mockFetch as unknown as typeof fetch,
    });

    expect(result.found).toBe(false);
    expect(result.error).toBe("Search API error: 500");
  });

  test("returns not found when API returns failure", async () => {
    const mockFetch = () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: "false" }),
      });

    const result = await searchTag("12345", {
      fetcher: mockFetch as unknown as typeof fetch,
    });

    expect(result.found).toBe(false);
    expect(result.error).toBe("Tag not found");
  });

  test("returns error when tag page fails", async () => {
    let callCount = 0;
    const mockFetch = () => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ success: "true", message: "/tags/123/" }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    };

    const result = await searchTag("12345", {
      fetcher: mockFetch as unknown as typeof fetch,
    });

    expect(result.found).toBe(false);
    expect(result.error).toBe("Tag page error: 404");
  });

  test("parses tag page when found", async () => {
    let callCount = 0;
    const mockFetch = () => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ success: "true", message: "/tags/40000/" }),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(tagPageHtml),
      });
    };

    const result = await searchTag("40000", {
      fetcher: mockFetch as unknown as typeof fetch,
    });

    expect(result.found).toBe(true);
    expect(result.tagId).toBe("40000");
    expect(result.status).toBe("Pass");
  });
});
