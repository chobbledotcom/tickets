var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined")
    return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/edge/bunny-script.ts
import * as BunnySDK from "https://esm.sh/@bunny.net/edgescript-sdk@0.10.0";

// src/lib/report-parser.ts
import { parse } from "https://esm.sh/node-html-parser@6.1.13";

// src/lib/constants.ts
var BASE_URL = "https://www.pipa.org.uk";
var SEARCH_API = "/umbraco/Surface/searchSurface/SearchTag";
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var CACHE_TTL_MS = 24 * 60 * 60 * 1000;
var CACHE_HOST = "pipa.org.uk";

// src/lib/dommatrix-polyfill.ts
import CSSMatrix from "https://esm.sh/@thednp/dommatrix@3.0.2";
var installDOMMatrixPolyfill = () => {
  if (typeof globalThis.DOMMatrix === "undefined") {
    globalThis.DOMMatrix = CSSMatrix;
  }
};

// src/lib/pdf-parser.ts
installDOMMatrixPolyfill();
var extractValue = (text, pattern) => {
  const match = text.match(pattern);
  return match?.[1]?.trim();
};
var parseDimensions = (dimStr) => {
  if (!dimStr)
    return {};
  const match = dimStr.match(/(\d+(?:\.\d+)?m?)\s*x\s*(\d+(?:\.\d+)?m?)\s*x\s*(\d+(?:\.\d+)?m?)/i);
  if (!match?.[1] || !match?.[2] || !match?.[3])
    return {};
  const length = match[1];
  const width = match[2];
  const height = match[3];
  return {
    length: length?.includes("m") ? length : `${length}m`,
    width: width?.includes("m") ? width : `${width}m`,
    height: height?.includes("m") ? height : `${height}m`
  };
};
var getStatusClass = (status) => {
  if (!status)
    return "unknown";
  const statusLower = status.toLowerCase();
  if (statusLower.includes("pass"))
    return "green";
  if (statusLower.includes("fail"))
    return "red";
  return "yellow";
};
var extractReportId = (text) => extractValue(text, /Report:\s*(\S+)/) ?? extractValue(text, /Inspection Report ID:\s*(\S+)/);
var extractTagInfo = (text) => {
  const pipaReferenceNumber = extractValue(text, /PIPA Device Reference Number:\s*(\d+)/);
  const tagNumber = extractValue(text, /Tag Number:\s*(\d+)/) ?? pipaReferenceNumber;
  return {
    pipaReferenceNumber: pipaReferenceNumber ?? undefined,
    tagNumber: tagNumber ?? undefined
  };
};
var extractStatus = (text) => {
  const statusMatch = text.match(/\b(Pass|Fail)\b\s+Inspection Valid From/i);
  const status = statusMatch?.[1] ?? null;
  return {
    status: status ?? undefined,
    statusClass: getStatusClass(status)
  };
};
var extractDates = (text) => ({
  validFrom: extractValue(text, /Inspection Valid From:\s*(\d{1,2}\s+\w+\s+\d{4})/) ?? undefined,
  expiryDate: extractValue(text, /Expiry Date:\s*(\d{1,2}\s+\w+\s+\d{4})/) ?? undefined
});
var extractInspectorInfo = (text) => ({
  inspector: extractValue(text, /Inspector Name:\s*([^\n]+?)(?=\s+Inspection Body:|$)/) ?? undefined,
  inspectionBody: extractValue(text, /Inspection Body:\s*([^\n]+?)(?=\s+Inspection Report ID:|$)/) ?? undefined
});
var extractDeviceDetails = (text) => ({
  manufacturer: extractValue(text, /Manufacturer:\s*([^\n]+?)(?=\s+Device Type:|$)/) ?? undefined,
  type: extractValue(text, /Device Type:\s*([^\n]+?)(?=\s+Manufactured Date:|$)/) ?? undefined,
  dateManufactured: extractValue(text, /Manufactured Date:\s*([^\n]+?)(?=\s+Device Description:|$)/) ?? undefined
});
var extractIndoorUseOnly = (text) => {
  const match = text.match(/Tested for Indoor Use Only\??\s*(Yes|No)/i);
  return match?.[1] ?? undefined;
};
var buildDeviceObject = (tagInfo, deviceDetails) => {
  const device = {};
  if (tagInfo.pipaReferenceNumber)
    device.pipaReferenceNumber = tagInfo.pipaReferenceNumber;
  if (tagInfo.tagNumber)
    device.tagNumber = tagInfo.tagNumber;
  if (deviceDetails.type)
    device.type = deviceDetails.type;
  if (deviceDetails.manufacturer)
    device.manufacturer = deviceDetails.manufacturer;
  if (deviceDetails.dateManufactured)
    device.dateManufactured = deviceDetails.dateManufactured;
  return Object.keys(device).length > 0 ? device : undefined;
};
var buildReportDetails = (inspector, indoorUseOnly) => {
  const reportDetails = {};
  if (inspector)
    reportDetails.inspector = inspector;
  if (indoorUseOnly)
    reportDetails.indoorUseOnly = indoorUseOnly;
  return Object.keys(reportDetails).length > 0 ? reportDetails : undefined;
};
var parsePdfText = (text) => {
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
  const dimensionsStr = extractValue(normalizedText, /Dimensions[^:]*:\s*([^\n]+?)(?=\s+Tested for Indoor|$)/);
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
    fetchedAt: new Date().toISOString()
  };
};
var parsePdfBuffer = async (buffer) => {
  const { PDFParse } = await import("https://esm.sh/pdf-parse@2.4.5");
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const parser = new PDFParse({ data });
  const result = await parser.getText();
  return parsePdfText(result.text);
};

// src/lib/report-parser.ts
var getDetailFromLabelRow = (label) => {
  const row = label.closest("tr");
  if (!row)
    return null;
  const detail = row.querySelector(".detail");
  return detail?.text.trim() || null;
};
var findDetailByLabel = (root, labelText) => {
  const labels = root.querySelectorAll(".label");
  for (const label of labels) {
    if (label.text.trim().startsWith(labelText)) {
      const value = getDetailFromLabelRow(label);
      if (value)
        return value;
    }
  }
  return null;
};
var extractFieldsByLabels = (root, fields) => {
  const result = {};
  for (const [key, label] of fields) {
    const value = findDetailByLabel(root, label);
    if (value)
      result[key] = value;
  }
  return result;
};
var extractBadgeFromRow = (row) => {
  const badge = row.querySelector("[class*='badge badge--']");
  if (!badge)
    return null;
  const classAttr = badge.getAttribute("class") ?? "";
  const classMatch = classAttr.match(/badge--(\w+)/);
  const statusClass = classMatch?.[1];
  if (!statusClass)
    return null;
  return {
    statusClass,
    status: badge.text.trim()
  };
};
var getBadgeFromLabelRow = (label) => {
  const row = label.closest("tr");
  if (!row)
    return null;
  return extractBadgeFromRow(row);
};
var findBadgeByLabel = (root, labelText) => {
  const labels = root.querySelectorAll(".label");
  for (const label of labels) {
    if (!label.text.trim().includes(labelText))
      continue;
    const badgeInfo = getBadgeFromLabelRow(label);
    if (badgeInfo)
      return badgeInfo;
  }
  return null;
};
var extractReportId2 = (root) => {
  const h1 = root.querySelector("h1");
  if (!h1)
    return null;
  const headerText = h1.text.trim();
  const match = headerText.match(/Inspection Report\s+(\S+)/);
  return match?.[1] ?? null;
};
var extractStatusBadge = (root) => {
  const statusBadge = root.querySelector("[class*='badge badge--']");
  if (!statusBadge)
    return {};
  const classAttr = statusBadge.getAttribute("class") ?? "";
  const classMatch = classAttr.match(/badge--(\w+)/);
  if (!classMatch)
    return {};
  return {
    statusClass: classMatch[1],
    status: statusBadge.text.trim()
  };
};
var extractImageUrl = (root) => {
  const img = root.querySelector('img[src*="hub.pipa.org.uk/content-files"]');
  if (!img)
    return null;
  const src = img.getAttribute("src");
  return src ? src.replace(/&amp;/g, "&") : null;
};
var extractIntroFields = (html) => {
  const root = parse(html);
  const intro = {};
  const reportId = extractReportId2(root);
  if (reportId)
    intro.reportId = reportId;
  const introFields = [
    ["id", "ID:"],
    ["validFrom", "Inspection Valid from:"],
    ["expiryDate", "Expiry Date:"],
    ["inspectionBody", "Inspection Body:"],
    ["tagNo", "Tag No:"],
    ["deviceType", "Device Type:"],
    ["serialNumber", "Serial Number:"]
  ];
  for (const [key, label] of introFields) {
    const value = findDetailByLabel(root, label);
    if (value)
      intro[key] = value;
  }
  Object.assign(intro, extractStatusBadge(root));
  const imageUrl = extractImageUrl(root);
  if (imageUrl)
    intro.imageUrl = imageUrl;
  return intro;
};
var findSectionTable = (root, headerText) => {
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
var REPORT_DETAIL_FIELDS = [
  ["creationDate", "Creation Date:"],
  ["inspectionDate", "Inspection Date:"],
  ["placeOfInspection", "Place of Inspection:"],
  ["inspector", "Inspector:"],
  ["structureVersion", "Structure version:"],
  ["indoorUseOnly", "Tested for Indoor Use Only:"]
];
var extractReportDetails = (html) => {
  const root = parse(html);
  return extractFieldsByLabels(root, REPORT_DETAIL_FIELDS);
};
var extractDeviceInfo = (html) => {
  const root = parse(html);
  const device = {};
  const deviceSection = findSectionTable(root, "Device");
  const fields = [
    ["pipaReferenceNumber", "PIPA Reference Number:"],
    ["tagNumber", "Tag Number:"],
    ["type", "Type:"],
    ["name", "Name:"],
    ["manufacturer", "Manufacturer:"],
    ["deviceSerialNumber", "Serial Number:"],
    ["dateManufactured", "Date Manufactured:"]
  ];
  const searchRoot = deviceSection ?? root;
  for (const [key, label] of fields) {
    const value = findDetailByLabel(searchRoot, label);
    if (value)
      device[key] = value;
  }
  const manualStatus = findBadgeByLabel(root, "operation manual present");
  if (manualStatus)
    device.operationManualPresent = manualStatus;
  return device;
};
var extractBadgeStatus = (row, field) => {
  const badgeInfo = extractBadgeFromRow(row);
  if (badgeInfo) {
    field.statusClass = badgeInfo.statusClass;
    field.status = badgeInfo.status;
  }
};
var extractDetailValues = (row, field) => {
  const details = row.querySelectorAll(".detail");
  const values = [];
  for (const detail of details) {
    const val = detail.text.trim();
    if (val)
      values.push(val);
  }
  if (values.length > 0) {
    field.value = values.join(" ").trim();
  }
};
var extractRowNotes = (row, field) => {
  const notesDiv = row.querySelector(".text");
  if (!notesDiv)
    return;
  const notes = notesDiv.text.trim();
  if (notes && notes !== "&nbsp;" && notes !== "") {
    field.notes = notes;
  }
};
var parseInspectionRow = (row) => {
  const labelDiv = row.querySelector(".label");
  if (!labelDiv)
    return null;
  const field = {
    label: labelDiv.text.trim().replace(/:$/, "")
  };
  const fieldRecord = field;
  extractBadgeStatus(row, fieldRecord);
  extractDetailValues(row, fieldRecord);
  extractRowNotes(row, fieldRecord);
  return field;
};
var sectionNameToKey = (name) => name.toLowerCase().replace(/[,&]/g, "").replace(/\s+(\w)/g, (_, c) => c.toUpperCase());
var SKIP_SECTIONS = new Set(["Report Details", "Device"]);
var processSection = (th) => {
  const sectionName = th.text.trim();
  if (SKIP_SECTIONS.has(sectionName))
    return null;
  const table = th.closest("table");
  if (!table)
    return null;
  const tbody = table.querySelector("tbody");
  if (!tbody)
    return null;
  const rows = tbody.querySelectorAll("tr");
  const fields = [];
  for (const row of rows) {
    const field = parseInspectionRow(row);
    if (field)
      fields.push(field);
  }
  if (fields.length === 0)
    return null;
  return { key: sectionNameToKey(sectionName), fields };
};
var extractInspectionSections = (html) => {
  const root = parse(html);
  const sections = {};
  const headers = root.querySelectorAll("th[colspan]");
  for (const th of headers) {
    const result = processSection(th);
    if (result)
      sections[result.key] = result.fields;
  }
  return sections;
};
var extractUserLimits = (html) => {
  const root = parse(html);
  const limits = {};
  const heightPatterns = [
    ["upTo1_0m", "Max Number of Users of Height up to 1.0m:"],
    ["upTo1_2m", "Max Number of Users of Height up to 1.2m:"],
    ["upTo1_5m", "Max Number of Users of Height up to 1.5m:"],
    ["upTo1_8m", "Max Number of Users of Height up to 1.8m:"]
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
var NOTES_FIELDS = [
  ["additionalNotes", "Additional Notes:"],
  ["riskAssessmentNotes", "Risk Assessment Notes:"],
  ["repairsNeeded", "Repairs needed to pass inspection:"],
  ["advisoryItems", "Advisory items"]
];
var processNoteValues = (notes) => Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, v.replace(/&#xA;/g, `
`)]));
var extractNotes = (html) => {
  const root = parse(html);
  const rawNotes = extractFieldsByLabels(root, NOTES_FIELDS);
  return processNoteValues(rawNotes);
};
var DIMENSION_FIELDS = [
  ["length", "Length:"],
  ["width", "Width:"],
  ["height", "Height:"]
];
var extractDimensions = (html) => {
  const root = parse(html);
  return extractFieldsByLabels(root, DIMENSION_FIELDS);
};
var parseReportPage = (html) => {
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
    fetchedAt: new Date().toISOString()
  };
};
var isValidReportUrl = (url) => url?.includes("hub.pipa.org.uk") ?? false;
var getRedirectUrl = (response) => {
  if (response.status >= 300 && response.status < 400) {
    return response.headers.get("location");
  }
  return null;
};
var isPdfContent = (response) => {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/pdf");
};
var fetchReport = async (reportUrl, options = {}) => {
  if (!isValidReportUrl(reportUrl)) {
    return { found: false, error: "Invalid report URL" };
  }
  const fetcher = options.fetcher ?? fetch;
  let response = await fetcher(reportUrl, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual"
  });
  const redirectUrl = getRedirectUrl(response);
  if (redirectUrl) {
    response = await fetcher(redirectUrl, {
      headers: { "User-Agent": USER_AGENT }
    });
  }
  if (!response.ok) {
    return { found: false, error: `Report fetch error: ${response.status}` };
  }
  if (isPdfContent(response)) {
    try {
      const buffer = await response.arrayBuffer();
      return await parsePdfBuffer(buffer);
    } catch (error) {
      return {
        found: false,
        isPdf: true,
        error: `PDF parsing failed: ${String(error)}`
      };
    }
  }
  const html = await response.text();
  return parseReportPage(html);
};
var fetchReportDetails = async (report, options = {}) => {
  if (!report?.url) {
    return {
      ...report ?? {},
      details: null,
      detailsError: "No report URL"
    };
  }
  const details = await fetchReport(report.url, options);
  if (!details.found) {
    return { ...report, details: null, detailsError: details.error };
  }
  return { ...report, details };
};
var fetchAllReportDetails = async (tagData, options = {}) => {
  if (!tagData?.found || !tagData?.annualReports?.length) {
    return tagData;
  }
  const detailedReports = await Promise.all(tagData.annualReports.map((report) => fetchReportDetails(report, options)));
  return { ...tagData, annualReports: detailedReports };
};

// src/lib/tag-parser.ts
var isAllNumbers = (str) => {
  if (!str || str.length === 0)
    return false;
  return /^\d+$/.test(str);
};
var extractText = (html, pattern) => {
  const match = html.match(pattern);
  return match?.[1]?.trim() ?? null;
};
var extractDetails = (html) => {
  const detailsSection = html.match(/check__details">([\s\S]*?)<\/div>\s*<div class="y-spacer/);
  if (!detailsSection?.[1])
    return {};
  const section = detailsSection[1];
  const details = {};
  const unitRef = extractText(section, /Unit Reference No:<\/div>\s*<div[^>]*>([^<]+)/);
  if (unitRef)
    details.unitReferenceNo = unitRef;
  const type = extractText(section, /Type:<\/div>\s*<div[^>]*>([^<]+)/);
  if (type)
    details.type = type;
  const operator = extractText(section, /Current Operator:<\/div>\s*<div[^>]*>([^<]+)/);
  if (operator)
    details.currentOperator = operator;
  const expiry = extractText(section, /Certificate Expiry Date:<\/div>\s*<div[^>]*>([^<]+)/);
  if (expiry)
    details.certificateExpiryDate = expiry;
  return details;
};
var extractAnnualReports = (html) => {
  const reportRegex = /<a class="report report--(\w+)" href="([^"]+)"[^>]*>[\s\S]*?report__date[\s\S]*?report__value">([^<]+)[\s\S]*?report__number[\s\S]*?report__value">([^<]+)[\s\S]*?report__company[\s\S]*?report__value">([^<]+)[\s\S]*?tag tag--small">([^<]+)/g;
  const matches = html.matchAll(reportRegex);
  const reports = [];
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
        status: status.trim()
      });
    }
  }
  return reports;
};
var parseTagPage = (html, tagId) => {
  const statusMatch = html.match(/check__image-tag--(\w+)"[^>]*>([^<]+)</i);
  const statusClass = statusMatch?.[1];
  const statusText = statusMatch?.[2];
  if (!statusClass || !statusText) {
    return { found: false, tagId };
  }
  const certificateUrl = extractText(html, /href="(https:\/\/hub\.pipa\.org\.uk\/download\/reports\/certificate\/[^"]+)"/);
  const reportUrl = extractText(html, /href="(https:\/\/hub\.pipa\.org\.uk\/public\/reports\/report\/[^"]+)"/);
  const imageUrl = extractText(html, /check__image[^>]*>[\s\S]*?<img src="([^"]+)"/);
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
    fetchedAt: new Date().toISOString()
  };
};
var fetchWithUserAgent = (url, fetcher) => fetcher(url, { headers: { "User-Agent": USER_AGENT } });
var fetchSearchApi = async (tagId, fetcher) => {
  const searchUrl = `${BASE_URL}${SEARCH_API}?Tag=${tagId}&PageId=1133`;
  const response = await fetchWithUserAgent(searchUrl, fetcher);
  if (!response.ok)
    return { ok: false, status: response.status };
  const data = await response.json();
  return { ok: true, data };
};
var fetchTagPage = async (tagPath, fetcher) => {
  const tagUrl = `${BASE_URL}${tagPath}`;
  const response = await fetchWithUserAgent(tagUrl, fetcher);
  if (!response.ok)
    return { ok: false, status: response.status };
  const html = await response.text();
  return { ok: true, html };
};
var searchTag = async (tagId, options = {}) => {
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

// src/edge/cache.ts
import { createClient } from "https://esm.sh/@libsql/client@0.6.0/web";
var db = null;
var getDb = () => {
  if (!db) {
    db = createClient({
      url: process.env.DB_URL,
      authToken: process.env.DB_TOKEN
    });
  }
  return db;
};
var initCache = async () => {
  await getDb().execute(`
    CREATE TABLE IF NOT EXISTS cache (
      host TEXT NOT NULL,
      id TEXT NOT NULL,
      cached TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (host, id)
    )
  `);
};
var readCache = async (tagId) => {
  const result = await getDb().execute({
    sql: "SELECT json, cached FROM cache WHERE host = ? AND id = ?",
    args: [CACHE_HOST, tagId]
  });
  if (result.rows.length === 0)
    return null;
  const row = result.rows[0];
  const cachedAt = new Date(row.cached).getTime();
  const age = Date.now() - cachedAt;
  if (age > CACHE_TTL_MS)
    return null;
  return { ...JSON.parse(row.json), fromCache: true };
};
var writeCache = async (tagId, data) => {
  await getDb().execute({
    sql: "INSERT OR REPLACE INTO cache (host, id, cached, json) VALUES (?, ?, ?, ?)",
    args: [CACHE_HOST, tagId, new Date().toISOString(), JSON.stringify(data)]
  });
};

// src/edge/bunny-script.ts
console.log("[PIPA] Edge script module loaded");
var handleCacheHit = async (cached, tagId) => {
  const hasDetails = cached.annualReports?.[0]?.details;
  const needsDetails = cached.annualReports?.length && !hasDetails;
  if (!needsDetails)
    return cached;
  const withDetails = await fetchAllReportDetails(cached);
  await writeCache(tagId, withDetails);
  return { ...withDetails, fromCache: false };
};
var fetchFreshData = async (tagId) => {
  const data = await searchTag(tagId);
  const finalData = data.found ? await fetchAllReportDetails(data) : data;
  if (finalData.found) {
    await writeCache(tagId, finalData);
  }
  return finalData;
};
var searchTagWithCache = async (tagId, useCache = true) => {
  if (useCache) {
    const cached = await readCache(tagId);
    if (cached)
      return handleCacheHit(cached, tagId);
  }
  return fetchFreshData(tagId);
};
var jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json" }
});
var getHomepageHtml = () => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PIPA Tag Search</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
    h1 { color: #333; }
    .search-form { background: #f5f5f5; padding: 1.5rem; border-radius: 8px; margin-bottom: 2rem; }
    .form-group { margin-bottom: 1rem; }
    label { display: block; margin-bottom: 0.5rem; font-weight: 500; }
    select, input { padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; }
    select { width: 200px; }
    input[type="text"] { width: 200px; }
    button { background: #0066cc; color: white; padding: 0.5rem 1.5rem; font-size: 1rem; border: none; border-radius: 4px; cursor: pointer; }
    button:hover { background: #0055aa; }
    button:disabled { background: #ccc; cursor: not-allowed; }
    .api-docs { background: #f9f9f9; padding: 1.5rem; border-radius: 8px; border-left: 4px solid #0066cc; }
    .api-docs h2 { margin-top: 0; }
    code { background: #e8e8e8; padding: 0.2rem 0.4rem; border-radius: 3px; font-family: monospace; }
    pre { background: #2d2d2d; color: #f8f8f2; padding: 1rem; border-radius: 4px; overflow-x: auto; }
    .endpoint { margin-bottom: 1.5rem; }
    .method { color: #22c55e; font-weight: bold; }
  </style>
</head>
<body>
  <h1>PIPA Tag Search</h1>

  <div class="search-form">
    <form id="searchForm">
      <div class="form-group">
        <label for="host">Host</label>
        <select id="host" name="host" required>
          <option value="">Please select</option>
          <option value="pipa.org.uk">pipa.org.uk</option>
        </select>
      </div>
      <div class="form-group">
        <label for="unitId">Unit ID</label>
        <input type="text" id="unitId" name="unitId" placeholder="e.g. 40000" required pattern="[0-9]+" title="Unit ID must be a number">
      </div>
      <div class="form-group">
        <label><input type="checkbox" id="useCache" name="useCache" checked> Use cache</label>
      </div>
      <button type="submit" id="searchBtn">Search</button>
    </form>
  </div>

  <div class="api-docs">
    <h2>API Documentation</h2>
    <p>This is an open API for searching PIPA (Playground Inspection Partners Association) safety tags.</p>

    <div class="endpoint">
      <h3><span class="method">GET</span> /tag/:id</h3>
      <p>Search for a PIPA tag by its ID number.</p>
      <p><strong>Parameters:</strong></p>
      <ul>
        <li><code>:id</code> - The numeric tag ID (e.g., 40000)</li>
      </ul>
      <p><strong>Example:</strong></p>
      <pre>curl https://test-searcher-upm2z.bunny.run/tag/40000</pre>
      <p><strong>Response:</strong></p>
      <pre>{
  "found": true,
  "tagId": "40000",
  "status": "Pass",
  "statusClass": "pass",
  "unitReferenceNo": "...",
  "type": "...",
  "currentOperator": "...",
  "certificateExpiryDate": "...",
  "certificateUrl": "...",
  "reportUrl": "...",
  "imageUrl": "...",
  "annualReports": [...],
  "fetchedAt": "..."
}</pre>
    </div>

    <div class="endpoint">
      <h3><span class="method">GET</span> /health</h3>
      <p>Health check endpoint.</p>
      <pre>curl https://test-searcher-upm2z.bunny.run/health</pre>
      <p><strong>Response:</strong> <code>{"status": "ok"}</code></p>
    </div>
  </div>

  <script>
    const form = document.getElementById('searchForm');
    const hostSelect = document.getElementById('host');
    const unitIdInput = document.getElementById('unitId');
    const useCacheCheckbox = document.getElementById('useCache');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!hostSelect.value) {
        alert('Please select a host');
        return;
      }
      const unitId = unitIdInput.value.trim();
      if (!unitId || !/^[0-9]+$/.test(unitId)) {
        alert('Please enter a valid numeric Unit ID');
        return;
      }
      const useCache = useCacheCheckbox.checked;
      let url = '/tag/' + encodeURIComponent(unitId);
      if (!useCache) {
        url += '?noCache=1';
      }
      window.location.href = url;
    });
  </script>
</body>
</html>`;
var handleRequest = async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/" || url.pathname === "") {
    return new Response(getHomepageHtml(), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
  if (url.pathname.startsWith("/tag/")) {
    const tagId = url.pathname.slice(5);
    const useCache = !url.searchParams.has("noCache");
    const result = await searchTagWithCache(tagId, useCache);
    return jsonResponse(result);
  }
  if (url.pathname === "/health") {
    return jsonResponse({ status: "ok" });
  }
  return jsonResponse({ error: "Not found" }, 404);
};
var initialized = false;
console.log("[PIPA] Registering HTTP handler...");
BunnySDK.net.http.serve(async (request) => {
  try {
    if (!initialized) {
      console.log("[PIPA] Initializing cache...");
      await initCache();
      initialized = true;
      console.log("[PIPA] Cache initialized successfully");
    }
    return handleRequest(request);
  } catch (error) {
    console.error("[PIPA] Request error:", error);
    return jsonResponse({ error: "Internal server error", message: String(error) }, 500);
  }
});
console.log("[PIPA] HTTP handler registered");
