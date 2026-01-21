/**
 * Tag page parsing functions
 * Parses PIPA tag search results and extracts tag information
 */

import { BASE_URL, SEARCH_API, USER_AGENT } from "./constants.ts";
import type {
  AnnualReport,
  FetchOptions,
  SearchApiResponse,
  TagDetails,
  TagResult,
} from "./types.ts";

/**
 * Check if a string contains only digits
 */
export const isAllNumbers = (str: string | null | undefined): boolean => {
  if (!str || str.length === 0) return false;
  return /^\d+$/.test(str);
};

/**
 * Extract text content from between HTML tags
 */
const extractText = (html: string, pattern: RegExp): string | null => {
  const match = html.match(pattern);
  return match?.[1]?.trim() ?? null;
};

/**
 * Extract details from the check__details HTML section
 */
export const extractDetails = (html: string): TagDetails => {
  const detailsSection = html.match(
    /check__details">([\s\S]*?)<\/div>\s*<div class="y-spacer/,
  );
  if (!detailsSection?.[1]) return {};

  const section = detailsSection[1];
  const details: TagDetails = {};

  const unitRef = extractText(
    section,
    /Unit Reference No:<\/div>\s*<div[^>]*>([^<]+)/,
  );
  if (unitRef) details.unitReferenceNo = unitRef;

  const type = extractText(section, /Type:<\/div>\s*<div[^>]*>([^<]+)/);
  if (type) details.type = type;

  const operator = extractText(
    section,
    /Current Operator:<\/div>\s*<div[^>]*>([^<]+)/,
  );
  if (operator) details.currentOperator = operator;

  const expiry = extractText(
    section,
    /Certificate Expiry Date:<\/div>\s*<div[^>]*>([^<]+)/,
  );
  if (expiry) details.certificateExpiryDate = expiry;

  return details;
};

/**
 * Extract annual reports from HTML
 */
export const extractAnnualReports = (html: string): AnnualReport[] => {
  const reportRegex =
    /<a class="report report--(\w+)" href="([^"]+)"[^>]*>[\s\S]*?report__date[\s\S]*?report__value">([^<]+)[\s\S]*?report__number[\s\S]*?report__value">([^<]+)[\s\S]*?report__company[\s\S]*?report__value">([^<]+)[\s\S]*?tag tag--small">([^<]+)/g;

  const matches = html.matchAll(reportRegex);
  const reports: AnnualReport[] = [];

  for (const match of matches) {
    const statusClass = match[1];
    const url = match[2];
    const date = match[3];
    const reportNo = match[4];
    const inspectionBody = match[5];
    const status = match[6];
    if (statusClass && url && date && reportNo && inspectionBody && status) {
      reports.push({
        statusClass,
        url,
        date: date.trim(),
        reportNo: reportNo.trim(),
        inspectionBody: inspectionBody.trim(),
        status: status.trim(),
      });
    }
  }

  return reports;
};

/**
 * Parse the PIPA tag details page HTML and extract data
 */
export const parseTagPage = (html: string, tagId: string): TagResult => {
  const statusMatch = html.match(/check__image-tag--(\w+)"[^>]*>([^<]+)</i);
  const statusClass = statusMatch?.[1];
  const statusText = statusMatch?.[2];
  if (!statusClass || !statusText) {
    return { found: false, tagId };
  }

  const certificateUrl = extractText(
    html,
    /href="(https:\/\/hub\.pipa\.org\.uk\/download\/reports\/certificate\/[^"]+)"/,
  );
  const reportUrl = extractText(
    html,
    /href="(https:\/\/hub\.pipa\.org\.uk\/public\/reports\/report\/[^"]+)"/,
  );
  const imageUrl = extractText(
    html,
    /check__image[^>]*>[\s\S]*?<img src="([^"]+)"/,
  );

  return {
    found: true,
    tagId,
    status: statusText.trim(),
    statusClass,
    ...extractDetails(html),
    certificateUrl,
    reportUrl,
    imageUrl,
    annualReports: extractAnnualReports(html),
    fetchedAt: new Date().toISOString(),
  };
};

/**
 * Fetch with user agent header
 */
const fetchWithUserAgent = (
  url: string,
  fetcher: typeof fetch,
): Promise<Response> => fetcher(url, { headers: { "User-Agent": USER_AGENT } });

/**
 * Fetch search API and return parsed JSON
 */
const fetchSearchApi = async (
  tagId: string,
  fetcher: typeof fetch,
): Promise<{ ok: boolean; data?: SearchApiResponse; status?: number }> => {
  const searchUrl = `${BASE_URL}${SEARCH_API}?Tag=${tagId}&PageId=1133`;
  const response = await fetchWithUserAgent(searchUrl, fetcher);
  if (!response.ok) return { ok: false, status: response.status };
  const data = (await response.json()) as SearchApiResponse;
  return { ok: true, data };
};

/**
 * Fetch tag page HTML
 */
const fetchTagPage = async (
  tagPath: string,
  fetcher: typeof fetch,
): Promise<{ ok: boolean; html?: string; status?: number }> => {
  const tagUrl = `${BASE_URL}${tagPath}`;
  const response = await fetchWithUserAgent(tagUrl, fetcher);
  if (!response.ok) return { ok: false, status: response.status };
  const html = await response.text();
  return { ok: true, html };
};

/**
 * Search for a PIPA tag by ID
 */
export const searchTag = async (
  tagId: string,
  options: FetchOptions = {},
): Promise<TagResult> => {
  const fetcher = options.fetcher ?? fetch;

  if (!isAllNumbers(tagId)) {
    return { found: false, error: "Invalid tag ID - must be all numbers" };
  }

  const searchResult = await fetchSearchApi(tagId, fetcher);
  if (!searchResult.ok) {
    return { found: false, error: `Search API error: ${searchResult.status}` };
  }

  if (searchResult.data?.success !== "true") {
    return { found: false, tagId, error: "Tag not found" };
  }

  const tagResult = await fetchTagPage(searchResult.data.message, fetcher);
  if (!tagResult.ok) {
    return { found: false, error: `Tag page error: ${tagResult.status}` };
  }

  return parseTagPage(tagResult.html ?? "", tagId);
};
