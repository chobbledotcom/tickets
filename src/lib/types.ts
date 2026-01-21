/**
 * TypeScript interfaces for PIPA Tag Search API
 */

export interface TagDetails {
  unitReferenceNo?: string;
  type?: string;
  currentOperator?: string;
  certificateExpiryDate?: string;
}

export interface BadgeStatus {
  statusClass: string;
  status: string;
}

export interface ReportDetails {
  found: boolean;
  reportId?: string;
  id?: string;
  validFrom?: string;
  expiryDate?: string;
  inspectionBody?: string;
  tagNo?: string;
  deviceType?: string;
  serialNumber?: string;
  statusClass?: string;
  status?: string;
  imageUrl?: string;
  reportDetails?: Record<string, string>;
  device?: Record<string, unknown>;
  dimensions?: Record<string, string>;
  userLimits?: Record<string, number | string>;
  notes?: Record<string, string>;
  inspectionSections?: Record<string, InspectionField[]>;
  fetchedAt?: string;
  error?: string;
  isPdf?: boolean;
}

export interface InspectionField {
  label: string;
  statusClass?: string;
  status?: string;
  value?: string;
  notes?: string;
}

export interface AnnualReport {
  statusClass: string;
  url: string;
  date: string;
  reportNo: string;
  inspectionBody: string;
  status: string;
  details?: ReportDetails | null;
  detailsError?: string;
}

export interface TagResult {
  found: boolean;
  tagId?: string;
  status?: string;
  statusClass?: string;
  unitReferenceNo?: string;
  type?: string;
  currentOperator?: string;
  certificateExpiryDate?: string;
  certificateUrl?: string | null;
  reportUrl?: string | null;
  imageUrl?: string | null;
  annualReports?: AnnualReport[];
  fetchedAt?: string;
  fromCache?: boolean;
  error?: string;
}

export interface CacheRow {
  host: string;
  id: string;
  cached: string;
  json: string;
}

export interface SearchApiResponse {
  success: string;
  message: string;
}

export interface FetchOptions {
  fetcher?: typeof fetch;
}

export interface CacheOptions extends FetchOptions {
  useCache?: boolean;
  cacheDir?: string;
}
