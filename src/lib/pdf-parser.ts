/**
 * PDF parsing functions
 * Parses PIPA inspection certificate PDFs from hub.pipa.org.uk
 */

import type { ReportDetails } from "./types.ts";

/**
 * Extract a single value from text using a pattern
 */
const extractValue = (
  text: string,
  pattern: RegExp,
): string | null | undefined => {
  const match = text.match(pattern);
  return match?.[1]?.trim();
};

/**
 * Parse dimensions string into object
 * Format: "5.5m x 3.9m x 3m"
 */
const parseDimensions = (
  dimStr: string | null | undefined,
): Record<string, string> => {
  if (!dimStr) return {};
  const match = dimStr.match(
    /(\d+(?:\.\d+)?m?)\s*x\s*(\d+(?:\.\d+)?m?)\s*x\s*(\d+(?:\.\d+)?m?)/i,
  );
  if (!match?.[1] || !match?.[2] || !match?.[3]) return {};
  const length = match[1];
  const width = match[2];
  const height = match[3];
  return {
    length: length?.includes("m") ? length : `${length}m`,
    width: width?.includes("m") ? width : `${width}m`,
    height: height?.includes("m") ? height : `${height}m`,
  };
};

/**
 * Determine status class from status text
 */
const getStatusClass = (status: string | null | undefined): string => {
  if (!status) return "unknown";
  const statusLower = status.toLowerCase();
  if (statusLower.includes("pass")) return "green";
  if (statusLower.includes("fail")) return "red";
  return "yellow";
};

/**
 * Extract report identification from normalized text
 */
const extractReportId = (text: string): string | null | undefined =>
  extractValue(text, /Report:\s*(\S+)/) ??
  extractValue(text, /Inspection Report ID:\s*(\S+)/);

/**
 * Extract tag/reference numbers from normalized text
 */
const extractTagInfo = (
  text: string,
): { pipaReferenceNumber?: string; tagNumber?: string } => {
  const pipaReferenceNumber = extractValue(
    text,
    /PIPA Device Reference Number:\s*(\d+)/,
  );
  const tagNumber =
    extractValue(text, /Tag Number:\s*(\d+)/) ?? pipaReferenceNumber;
  return {
    pipaReferenceNumber: pipaReferenceNumber ?? undefined,
    tagNumber: tagNumber ?? undefined,
  };
};

/**
 * Extract status from normalized text
 */
const extractStatus = (
  text: string,
): { status?: string; statusClass: string } => {
  const statusMatch = text.match(/\b(Pass|Fail)\b\s+Inspection Valid From/i);
  const status = statusMatch?.[1] ?? null;
  return {
    status: status ?? undefined,
    statusClass: getStatusClass(status),
  };
};

/**
 * Extract validity dates from normalized text
 */
const extractDates = (
  text: string,
): { validFrom?: string; expiryDate?: string } => ({
  validFrom:
    extractValue(text, /Inspection Valid From:\s*(\d{1,2}\s+\w+\s+\d{4})/) ??
    undefined,
  expiryDate:
    extractValue(text, /Expiry Date:\s*(\d{1,2}\s+\w+\s+\d{4})/) ?? undefined,
});

/**
 * Extract inspector info from normalized text
 */
const extractInspectorInfo = (
  text: string,
): { inspector?: string; inspectionBody?: string } => ({
  inspector:
    extractValue(
      text,
      /Inspector Name:\s*([^\n]+?)(?=\s+Inspection Body:|$)/,
    ) ?? undefined,
  inspectionBody:
    extractValue(
      text,
      /Inspection Body:\s*([^\n]+?)(?=\s+Inspection Report ID:|$)/,
    ) ?? undefined,
});

/**
 * Extract device info from normalized text
 */
const extractDeviceDetails = (
  text: string,
): Record<string, string | undefined> => ({
  manufacturer:
    extractValue(text, /Manufacturer:\s*([^\n]+?)(?=\s+Device Type:|$)/) ??
    undefined,
  type:
    extractValue(text, /Device Type:\s*([^\n]+?)(?=\s+Manufactured Date:|$)/) ??
    undefined,
  dateManufactured:
    extractValue(
      text,
      /Manufactured Date:\s*([^\n]+?)(?=\s+Device Description:|$)/,
    ) ?? undefined,
});

/**
 * Extract indoor use flag from normalized text
 */
const extractIndoorUseOnly = (text: string): string | undefined => {
  const match = text.match(/Tested for Indoor Use Only\??\s*(Yes|No)/i);
  return match?.[1] ?? undefined;
};

/**
 * Build device object from extracted values
 */
const buildDeviceObject = (
  tagInfo: { pipaReferenceNumber?: string; tagNumber?: string },
  deviceDetails: Record<string, string | undefined>,
): Record<string, unknown> | undefined => {
  const device: Record<string, unknown> = {};
  if (tagInfo.pipaReferenceNumber)
    device.pipaReferenceNumber = tagInfo.pipaReferenceNumber;
  if (tagInfo.tagNumber) device.tagNumber = tagInfo.tagNumber;
  if (deviceDetails.type) device.type = deviceDetails.type;
  if (deviceDetails.manufacturer)
    device.manufacturer = deviceDetails.manufacturer;
  if (deviceDetails.dateManufactured)
    device.dateManufactured = deviceDetails.dateManufactured;
  return Object.keys(device).length > 0 ? device : undefined;
};

/**
 * Build report details object from extracted values
 */
const buildReportDetails = (
  inspector?: string,
  indoorUseOnly?: string,
): Record<string, string> | undefined => {
  const reportDetails: Record<string, string> = {};
  if (inspector) reportDetails.inspector = inspector;
  if (indoorUseOnly) reportDetails.indoorUseOnly = indoorUseOnly;
  return Object.keys(reportDetails).length > 0 ? reportDetails : undefined;
};

/**
 * Parse PDF text content into ReportDetails
 */
export const parsePdfText = (text: string): ReportDetails => {
  if (!text || text.length === 0) {
    return { found: false, error: "Empty PDF text content" };
  }

  const normalizedText = text.replace(/\s+/g, " ");
  const reportId = extractReportId(normalizedText);
  const tagInfo = extractTagInfo(normalizedText);
  const { status, statusClass } = extractStatus(normalizedText);
  const { validFrom, expiryDate } = extractDates(normalizedText);
  const { inspector, inspectionBody } = extractInspectorInfo(normalizedText);
  const deviceDetails = extractDeviceDetails(normalizedText);
  const indoorUseOnly = extractIndoorUseOnly(normalizedText);
  const dimensionsStr = extractValue(
    normalizedText,
    /Dimensions[^:]*:\s*([^\n]+?)(?=\s+Tested for Indoor|$)/,
  );
  const dimensions = parseDimensions(dimensionsStr);

  return {
    found: true,
    isPdf: true,
    reportId: reportId ?? undefined,
    id: reportId ?? undefined,
    validFrom,
    expiryDate,
    inspectionBody,
    tagNo: tagInfo.tagNumber,
    deviceType: deviceDetails.type,
    statusClass,
    status,
    reportDetails: buildReportDetails(inspector, indoorUseOnly),
    device: buildDeviceObject(tagInfo, deviceDetails),
    dimensions: Object.keys(dimensions).length > 0 ? dimensions : undefined,
    fetchedAt: new Date().toISOString(),
  };
};

/**
 * Parse a PDF buffer into ReportDetails
 * Uses unpdf for PDF parsing
 */
export const parsePdfBuffer = async (
  buffer: ArrayBuffer | Uint8Array,
): Promise<ReportDetails> => {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: true });
  return parsePdfText(text);
};
