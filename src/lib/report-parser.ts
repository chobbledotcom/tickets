/**
 * Report parsing functions
 * Parses detailed PIPA inspection report pages from hub.pipa.org.uk
 */

import { type HTMLElement, parse } from "node-html-parser";
import { USER_AGENT } from "./constants.ts";
import { parsePdfBuffer } from "./pdf-parser.ts";
import type {
  AnnualReport,
  BadgeStatus,
  FetchOptions,
  InspectionField,
  ReportDetails,
  TagResult,
} from "./types.ts";

/**
 * Get detail value from a row containing a label
 */
const getDetailFromLabelRow = (label: HTMLElement): string | null => {
  const row = label.closest("tr");
  if (!row) return null;
  const detail = row.querySelector(".detail");
  return detail?.text.trim() || null;
};

/**
 * Find a row by label text and extract the detail value
 */
const findDetailByLabel = (
  root: HTMLElement,
  labelText: string,
): string | null => {
  const labels = root.querySelectorAll(".label");
  for (const label of labels) {
    if (label.text.trim().startsWith(labelText)) {
      const value = getDetailFromLabelRow(label);
      if (value) return value;
    }
  }
  return null;
};

/**
 * Extract multiple fields by label into a record
 */
const extractFieldsByLabels = (
  root: HTMLElement,
  fields: [string, string][],
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, label] of fields) {
    const value = findDetailByLabel(root, label);
    if (value) result[key] = value;
  }
  return result;
};

/**
 * Extract badge info from a row
 */
const extractBadgeFromRow = (row: HTMLElement): BadgeStatus | null => {
  const badge = row.querySelector("[class*='badge badge--']");
  if (!badge) return null;
  const classAttr = badge.getAttribute("class") ?? "";
  const classMatch = classAttr.match(/badge--(\w+)/);
  const statusClass = classMatch?.[1];
  if (!statusClass) return null;
  return {
    statusClass,
    status: badge.text.trim(),
  };
};

/**
 * Get badge from a label's row
 */
const getBadgeFromLabelRow = (label: HTMLElement): BadgeStatus | null => {
  const row = label.closest("tr");
  if (!row) return null;
  return extractBadgeFromRow(row);
};

/**
 * Find a badge by label text and extract status info
 */
const findBadgeByLabel = (
  root: HTMLElement,
  labelText: string,
): BadgeStatus | null => {
  const labels = root.querySelectorAll(".label");
  for (const label of labels) {
    if (!label.text.trim().includes(labelText)) continue;
    const badgeInfo = getBadgeFromLabelRow(label);
    if (badgeInfo) return badgeInfo;
  }
  return null;
};

/**
 * Extract report ID from header
 */
const extractReportId = (root: HTMLElement): string | null => {
  const h1 = root.querySelector("h1");
  if (!h1) return null;
  const headerText = h1.text.trim();
  const match = headerText.match(/Inspection Report\s+(\S+)/);
  return match?.[1] ?? null;
};

/**
 * Extract status badge info from HTML
 */
const extractStatusBadge = (
  root: HTMLElement,
): { statusClass?: string; status?: string } => {
  const statusBadge = root.querySelector("[class*='badge badge--']");
  if (!statusBadge) return {};
  const classAttr = statusBadge.getAttribute("class") ?? "";
  const classMatch = classAttr.match(/badge--(\w+)/);
  if (!classMatch) return {};
  return {
    statusClass: classMatch[1],
    status: statusBadge.text.trim(),
  };
};

/**
 * Extract image URL from HTML
 */
const extractImageUrl = (root: HTMLElement): string | null => {
  const img = root.querySelector('img[src*="hub.pipa.org.uk/content-files"]');
  if (!img) return null;
  const src = img.getAttribute("src");
  return src ? src.replace(/&amp;/g, "&") : null;
};

/**
 * Extract intro section fields from report HTML
 */
export const extractIntroFields = (html: string): Record<string, unknown> => {
  const root = parse(html);
  const intro: Record<string, unknown> = {};

  const reportId = extractReportId(root);
  if (reportId) intro.reportId = reportId;

  const introFields: [string, string][] = [
    ["id", "ID:"],
    ["validFrom", "Inspection Valid from:"],
    ["expiryDate", "Expiry Date:"],
    ["inspectionBody", "Inspection Body:"],
    ["tagNo", "Tag No:"],
    ["deviceType", "Device Type:"],
    ["serialNumber", "Serial Number:"],
  ];

  for (const [key, label] of introFields) {
    const value = findDetailByLabel(root, label);
    if (value) intro[key] = value;
  }

  Object.assign(intro, extractStatusBadge(root));

  const imageUrl = extractImageUrl(root);
  if (imageUrl) intro.imageUrl = imageUrl;

  return intro;
};

/**
 * Find a section table by header text
 */
const findSectionTable = (
  root: HTMLElement,
  headerText: string,
): HTMLElement | null => {
  const headers = root.querySelectorAll("th[colspan]");
  for (const th of headers) {
    if (th.text.trim() === headerText) {
      const table = th.closest("table");
      if (table) {
        return table.querySelector("tbody");
      }
    }
  }
  return null;
};

const REPORT_DETAIL_FIELDS: [string, string][] = [
  ["creationDate", "Creation Date:"],
  ["inspectionDate", "Inspection Date:"],
  ["placeOfInspection", "Place of Inspection:"],
  ["inspector", "Inspector:"],
  ["structureVersion", "Structure version:"],
  ["indoorUseOnly", "Tested for Indoor Use Only:"],
];

/**
 * Extract report details section
 */
export const extractReportDetails = (html: string): Record<string, string> => {
  const root = parse(html);
  return extractFieldsByLabels(root, REPORT_DETAIL_FIELDS);
};

/**
 * Extract device information section
 */
export const extractDeviceInfo = (html: string): Record<string, unknown> => {
  const root = parse(html);
  const device: Record<string, unknown> = {};

  const deviceSection = findSectionTable(root, "Device");

  const fields: [string, string][] = [
    ["pipaReferenceNumber", "PIPA Reference Number:"],
    ["tagNumber", "Tag Number:"],
    ["type", "Type:"],
    ["name", "Name:"],
    ["manufacturer", "Manufacturer:"],
    ["deviceSerialNumber", "Serial Number:"],
    ["dateManufactured", "Date Manufactured:"],
  ];

  const searchRoot = deviceSection ?? root;

  for (const [key, label] of fields) {
    const value = findDetailByLabel(searchRoot, label);
    if (value) device[key] = value;
  }

  const manualStatus = findBadgeByLabel(root, "operation manual present");
  if (manualStatus) device.operationManualPresent = manualStatus;

  return device;
};

/**
 * Extract badge status from row element
 */
const extractBadgeStatus = (
  row: HTMLElement,
  field: Record<string, unknown>,
): void => {
  const badgeInfo = extractBadgeFromRow(row);
  if (badgeInfo) {
    field.statusClass = badgeInfo.statusClass;
    field.status = badgeInfo.status;
  }
};

/**
 * Extract detail values from row element
 */
const extractDetailValues = (
  row: HTMLElement,
  field: Record<string, unknown>,
): void => {
  const details = row.querySelectorAll(".detail");
  const values: string[] = [];
  for (const detail of details) {
    const val = detail.text.trim();
    if (val) values.push(val);
  }
  if (values.length > 0) {
    field.value = values.join(" ").trim();
  }
};

/**
 * Extract notes from row element
 */
const extractRowNotes = (
  row: HTMLElement,
  field: Record<string, unknown>,
): void => {
  const notesDiv = row.querySelector(".text");
  if (!notesDiv) return;
  const notes = notesDiv.text.trim();
  if (notes && notes !== "&nbsp;" && notes !== "") {
    field.notes = notes;
  }
};

/**
 * Parse a single inspection row
 */
const parseInspectionRow = (row: HTMLElement): InspectionField | null => {
  const labelDiv = row.querySelector(".label");
  if (!labelDiv) return null;

  const field: InspectionField = {
    label: labelDiv.text.trim().replace(/:$/, ""),
  };
  const fieldRecord = field as unknown as Record<string, unknown>;
  extractBadgeStatus(row, fieldRecord);
  extractDetailValues(row, fieldRecord);
  extractRowNotes(row, fieldRecord);

  return field;
};

/**
 * Convert section name to camelCase key
 */
const sectionNameToKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[,&]/g, "")
    .replace(/\s+(\w)/g, (_, c: string) => c.toUpperCase());

const SKIP_SECTIONS = new Set(["Report Details", "Device"]);

/**
 * Process a single section header and extract fields
 */
const processSection = (
  th: HTMLElement,
): { key: string; fields: InspectionField[] } | null => {
  const sectionName = th.text.trim();
  if (SKIP_SECTIONS.has(sectionName)) return null;

  const table = th.closest("table");
  if (!table) return null;

  const tbody = table.querySelector("tbody");
  if (!tbody) return null;

  const rows = tbody.querySelectorAll("tr");
  const fields: InspectionField[] = [];

  for (const row of rows) {
    const field = parseInspectionRow(row);
    if (field) fields.push(field);
  }

  if (fields.length === 0) return null;

  return { key: sectionNameToKey(sectionName), fields };
};

/**
 * Extract all inspection sections (Structure, Materials, etc.)
 */
export const extractInspectionSections = (
  html: string,
): Record<string, InspectionField[]> => {
  const root = parse(html);
  const sections: Record<string, InspectionField[]> = {};

  const headers = root.querySelectorAll("th[colspan]");
  for (const th of headers) {
    const result = processSection(th);
    if (result) sections[result.key] = result.fields;
  }

  return sections;
};

/**
 * Extract user capacity limits
 */
export const extractUserLimits = (
  html: string,
): Record<string, number | string> => {
  const root = parse(html);
  const limits: Record<string, number | string> = {};

  const heightPatterns: [string, string][] = [
    ["upTo1_0m", "Max Number of Users of Height up to 1.0m:"],
    ["upTo1_2m", "Max Number of Users of Height up to 1.2m:"],
    ["upTo1_5m", "Max Number of Users of Height up to 1.5m:"],
    ["upTo1_8m", "Max Number of Users of Height up to 1.8m:"],
  ];

  for (const [key, label] of heightPatterns) {
    const value = findDetailByLabel(root, label);
    if (value) {
      const num = Number.parseInt(value, 10);
      if (!Number.isNaN(num)) {
        limits[key] = num;
      }
    }
  }

  const customValue = findDetailByLabel(root, "Custom Max User Height:");
  if (customValue) {
    limits.customMaxHeight = customValue;
  }

  return limits;
};

const NOTES_FIELDS: [string, string][] = [
  ["additionalNotes", "Additional Notes:"],
  ["riskAssessmentNotes", "Risk Assessment Notes:"],
  ["repairsNeeded", "Repairs needed to pass inspection:"],
  ["advisoryItems", "Advisory items"],
];

/**
 * Process notes to convert HTML entities to newlines
 */
const processNoteValues = (
  notes: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(notes).map(([k, v]) => [k, v.replace(/&#xA;/g, "\n")]),
  );

/**
 * Extract notes section
 */
export const extractNotes = (html: string): Record<string, string> => {
  const root = parse(html);
  const rawNotes = extractFieldsByLabels(root, NOTES_FIELDS);
  return processNoteValues(rawNotes);
};

const DIMENSION_FIELDS: [string, string][] = [
  ["length", "Length:"],
  ["width", "Width:"],
  ["height", "Height:"],
];

/**
 * Extract key dimensions from Structure section
 */
export const extractDimensions = (html: string): Record<string, string> => {
  const root = parse(html);
  return extractFieldsByLabels(root, DIMENSION_FIELDS);
};

/**
 * Parse a complete PIPA report page
 */
export const parseReportPage = (html: string): ReportDetails => {
  if (!html.includes("Inspection Report") && !html.includes("badge badge--")) {
    return { found: false };
  }

  const intro = extractIntroFields(html);
  const reportDetails = extractReportDetails(html);
  const device = extractDeviceInfo(html);
  const dimensions = extractDimensions(html);
  const userLimits = extractUserLimits(html);
  const notes = extractNotes(html);
  const sections = extractInspectionSections(html);

  return {
    found: true,
    ...intro,
    reportDetails,
    device,
    dimensions,
    userLimits,
    notes,
    inspectionSections: sections,
    fetchedAt: new Date().toISOString(),
  } as ReportDetails;
};

/**
 * Check if URL is a valid PIPA report URL
 */
const isValidReportUrl = (url: string | null | undefined): boolean =>
  url?.includes("hub.pipa.org.uk") ?? false;

/**
 * Check if response is a redirect (likely PDF download)
 * Returns the redirect URL if found, null otherwise
 */
const getRedirectUrl = (response: Response): string | null => {
  if (response.status >= 300 && response.status < 400) {
    return response.headers.get("location");
  }
  return null;
};

/**
 * Check if response is PDF content type
 */
const isPdfContent = (response: Response): boolean => {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/pdf");
};

/**
 * Fetch and parse a PIPA report
 */
export const fetchReport = async (
  reportUrl: string | null | undefined,
  options: FetchOptions = {},
): Promise<ReportDetails> => {
  if (!isValidReportUrl(reportUrl)) {
    return { found: false, error: "Invalid report URL" };
  }

  const fetcher = options.fetcher ?? fetch;
  let response = await fetcher(reportUrl as string, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
  });

  // Follow redirect to PDF if present
  const redirectUrl = getRedirectUrl(response);
  if (redirectUrl) {
    response = await fetcher(redirectUrl, {
      headers: { "User-Agent": USER_AGENT },
    });
  }

  if (!response.ok) {
    return { found: false, error: `Report fetch error: ${response.status}` };
  }

  // Handle PDF content - parse it instead of erroring
  if (isPdfContent(response)) {
    try {
      const buffer = await response.arrayBuffer();
      return await parsePdfBuffer(buffer);
    } catch (error) {
      return {
        found: false,
        isPdf: true,
        error: `PDF parsing failed: ${String(error)}`,
      };
    }
  }

  const html = await response.text();
  return parseReportPage(html);
};

/**
 * Fetch detailed report data for a single annual report
 */
export const fetchReportDetails = async (
  report: AnnualReport | null | undefined,
  options: FetchOptions = {},
): Promise<AnnualReport> => {
  if (!report?.url) {
    return {
      ...(report ?? ({} as AnnualReport)),
      details: null,
      detailsError: "No report URL",
    };
  }

  const details = await fetchReport(report.url, options);

  if (!details.found) {
    return { ...report, details: null, detailsError: details.error };
  }

  return { ...report, details };
};

/**
 * Fetch detailed reports for all annual reports of a tag
 */
export const fetchAllReportDetails = async (
  tagData: TagResult | null | undefined,
  options: FetchOptions = {},
): Promise<TagResult> => {
  if (!tagData?.found || !tagData?.annualReports?.length) {
    return tagData as TagResult;
  }

  const detailedReports = await Promise.all(
    tagData.annualReports.map((report) => fetchReportDetails(report, options)),
  );

  return { ...tagData, annualReports: detailedReports };
};
