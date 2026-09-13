import type {
  AnalyticsAccount,
  AnalyticsApiError,
  AnalyticsDataStream,
  AnalyticsProperty,
  AnalyticsReport,
  AnalyticsVisitorsReport,
} from "./types.ts";

const ADMIN_API_BASE = "https://analyticsadmin.googleapis.com/v1beta";
const DATA_API_BASE = "https://analyticsdata.googleapis.com/v1beta";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

interface AnalyticsConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUri: string;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface CreatePropertyInput {
  account: string;
  displayName: string;
  timeZone: string;
  currencyCode: string;
  industryCategory?: string;
}

export interface CreateWebStreamInput {
  property: string;
  displayName: string;
  defaultUri: string;
}

let tokenCache: TokenCache | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function configuredValues(): string[] {
  return [
    process.env.GOOGLE_ANALYTICS_CLIENT_ID,
    process.env.GOOGLE_ANALYTICS_CLIENT_SECRET,
    process.env.GOOGLE_ANALYTICS_REFRESH_TOKEN,
    process.env.GOOGLE_ANALYTICS_TOKEN_URI,
  ].filter((value): value is string => Boolean(value));
}

function redact(value: string): string {
  let safe = value;
  for (const secret of configuredValues()) {
    if (secret.length >= 3) safe = safe.split(secret).join("[redacted]");
  }
  return safe
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/(access_token|refresh_token|client_secret)=([^&\s]+)/gi, "$1=[redacted]");
}

function config(): AnalyticsConfig {
  const names = {
    clientId: "GOOGLE_ANALYTICS_CLIENT_ID",
    clientSecret: "GOOGLE_ANALYTICS_CLIENT_SECRET",
    refreshToken: "GOOGLE_ANALYTICS_REFRESH_TOKEN",
  } as const;
  const missing = Object.values(names).filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Google Analytics credentials missing: ${missing.join(", ")}. ` +
        "Set GOOGLE_ANALYTICS_CLIENT_ID, GOOGLE_ANALYTICS_CLIENT_SECRET, and GOOGLE_ANALYTICS_REFRESH_TOKEN in the environment or credential runner.",
    );
  }

  const tokenUri = process.env.GOOGLE_ANALYTICS_TOKEN_URI?.trim() || DEFAULT_TOKEN_URI;
  if (!/^https:\/\//i.test(tokenUri)) throw new Error("GOOGLE_ANALYTICS_TOKEN_URI must use HTTPS.");

  return {
    clientId: process.env[names.clientId]!.trim(),
    clientSecret: process.env[names.clientSecret]!.trim(),
    refreshToken: process.env[names.refreshToken]!.trim(),
    tokenUri,
  };
}

async function parseJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Google Analytics API returned malformed JSON (HTTP ${response.status}).`);
  }
}

function tokenFailure(response: Response, payload: unknown): Error {
  const body = isRecord(payload) ? payload : {};
  const code = nonEmptyString(body.error) ? body.error : `HTTP ${response.status}`;
  const detail = nonEmptyString(body.error_description) ? `: ${redact(body.error_description)}` : "";
  return new Error(`Google Analytics token refresh failed (${redact(code)})${detail}.`);
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.accessToken;

  const current = config();
  const body = new URLSearchParams({
    client_id: current.clientId,
    client_secret: current.clientSecret,
    refresh_token: current.refreshToken,
    grant_type: "refresh_token",
  });

  let response: Response;
  try {
    response = await fetch(current.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (error) {
    const detail = error instanceof Error ? redact(error.message) : "request failed";
    throw new Error(`Google Analytics token refresh request failed: ${detail}`);
  }

  let payload: unknown;
  try {
    payload = await parseJson(response);
  } catch {
    throw new Error(`Google Analytics token refresh returned malformed JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) throw tokenFailure(response, payload);
  if (!isRecord(payload) || !nonEmptyString(payload.access_token)) {
    throw new Error("Google Analytics token refresh returned no access token.");
  }

  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
    ? payload.expires_in
    : 3600;
  if (expiresIn <= 0) throw new Error("Google Analytics token refresh returned an invalid expiry.");
  tokenCache = { accessToken: payload.access_token.trim(), expiresAt: Date.now() + expiresIn * 1000 };
  return tokenCache.accessToken;
}

function apiError(response: Response, payload: unknown): Error {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error as AnalyticsApiError : {};
  const message = nonEmptyString(error.message) ? error.message.toLowerCase() : "";
  const reasons = Array.isArray(error.errors)
    ? error.errors
        .map((entry) => (isRecord(entry) && nonEmptyString(entry.reason) ? entry.reason.toLowerCase() : ""))
        .filter(Boolean)
    : [];
  const insufficientScope =
    (message.includes("insufficient") && message.includes("scope")) ||
    reasons.some((reason) => reason.includes("insufficient") || reason.includes("scope"));
  if (insufficientScope) {
    return new Error(
      "Google Analytics API rejected the request because the OAuth profile lacks the required " +
        "analytics.readonly and analytics.edit scopes; reauthorize the configured credential source.",
    );
  }
  if (response.status === 401) {
    return new Error("Google Analytics API authentication failed; the OAuth profile may be stale.");
  }
  if (response.status === 403) return new Error("Google Analytics API access denied for this account or property.");
  if (response.status === 404) return new Error("Google Analytics resource was not found or is not accessible.");
  return new Error(`Google Analytics API request failed (HTTP ${response.status}).`);
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const accessToken = await getAccessToken();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? redact(error.message) : "request failed";
    throw new Error(`Google Analytics API request failed: ${detail}`);
  }
  let payload: unknown;
  try {
    payload = await parseJson(response);
  } catch {
    throw new Error(`Google Analytics API returned malformed JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) throw apiError(response, payload);
  return payload as T;
}

function resourceId(value: string, prefix: "accounts" | "properties" | "dataStreams", label: string): string {
  const input = value.trim();
  if (!input || /[\r\n]/.test(input)) throw new Error(`${label} is required and cannot contain line breaks.`);
  const expected = `${prefix}/`;
  const id = input.startsWith(expected) ? input.slice(expected.length) : input;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${label} must be a Google Analytics ${prefix} ID or resource name.`);
  return id;
}

export function accountResource(value: string): string {
  return `accounts/${resourceId(value, "accounts", "account")}`;
}

export function propertyResource(value: string): string {
  return `properties/${resourceId(value, "properties", "property")}`;
}

function streamResource(value: string): string {
  const input = value.trim();
  if (!/^properties\/[A-Za-z0-9_-]+\/dataStreams\/[A-Za-z0-9_-]+$/.test(input)) {
    throw new Error("stream must be a properties/<id>/dataStreams/<id> resource name.");
  }
  return input;
}

function parseDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD.`);
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a real calendar date.`);
  }
  return value;
}

export function dateRange(days: number, endDate?: string): DateRange {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("days must be an integer from 1 to 365.");
  const end = parseDate(endDate ?? new Date().toISOString().slice(0, 10), "end-date");
  const endTimestamp = Date.parse(`${end}T00:00:00Z`);
  const start = new Date(endTimestamp - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { startDate: start, endDate: end };
}

function safeLabel(value: unknown): string | undefined {
  if (!nonEmptyString(value)) return undefined;
  const label = value.trim();
  if (/\r|\n/.test(label) || /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(label)) return "[redacted label]";
  return label.slice(0, 200);
}

function parseAccount(entry: unknown, index: number): AnalyticsAccount {
  if (!isRecord(entry) || !nonEmptyString(entry.name)) {
    throw new Error(`Google Analytics accounts response was malformed at entry ${index}.`);
  }
  const name = entry.name.trim();
  if (!/^accounts\/[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Google Analytics accounts response was malformed at entry ${index}.`);
  }
  return { name, accountId: name.slice("accounts/".length), displayName: safeLabel(entry.displayName) };
}

function parseProperty(entry: unknown, index: number): AnalyticsProperty {
  if (!isRecord(entry) || !nonEmptyString(entry.name) || !nonEmptyString(entry.parent)) {
    throw new Error(`Google Analytics properties response was malformed at entry ${index}.`);
  }
  const name = entry.name.trim();
  const parent = entry.parent.trim();
  if (!/^properties\/[A-Za-z0-9_-]+$/.test(name) || !/^accounts\/[A-Za-z0-9_-]+$/.test(parent)) {
    throw new Error(`Google Analytics properties response was malformed at entry ${index}.`);
  }
  return {
    name,
    propertyId: name.slice("properties/".length),
    parent,
    displayName: safeLabel(entry.displayName),
    timeZone: safeLabel(entry.timeZone),
    currencyCode: safeLabel(entry.currencyCode),
  };
}

function parseStream(entry: unknown, index: number): AnalyticsDataStream {
  if (!isRecord(entry) || !nonEmptyString(entry.name) || !nonEmptyString(entry.type)) {
    throw new Error(`Google Analytics data streams response was malformed at entry ${index}.`);
  }
  const name = entry.name.trim();
  const match = /^properties\/([A-Za-z0-9_-]+)\/dataStreams\/([A-Za-z0-9_-]+)$/.exec(name);
  if (!match) throw new Error(`Google Analytics data streams response was malformed at entry ${index}.`);
  const web = isRecord(entry.webStreamData) ? entry.webStreamData : undefined;
  const measurementId = web && nonEmptyString(web.measurementId) ? web.measurementId.trim() : undefined;
  const defaultUri = web && nonEmptyString(web.defaultUri) ? web.defaultUri.trim() : undefined;
  return {
    name,
    streamId: match[2]!,
    propertyId: match[1]!,
    displayName: safeLabel(entry.displayName),
    type: entry.type.trim(),
    measurementId: measurementId && /^[A-Za-z0-9-]+$/.test(measurementId) ? measurementId : undefined,
    defaultUri: defaultUri && /^https?:\/\/[^\s\r\n]+$/i.test(defaultUri) ? defaultUri : undefined,
  };
}

async function listPaged<T>(path: string, parse: (entry: unknown, index: number) => T, base = ADMIN_API_BASE): Promise<T[]> {
  const entries: T[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({ pageSize: "200" });
    if (pageToken) query.set("pageToken", pageToken);
    const payload = await request<unknown>(base, `${path}${path.includes("?") ? "&" : "?"}${query}`);
    if (!isRecord(payload)) throw new Error("Google Analytics paginated response was malformed.");
    const raw = payload.accounts ?? payload.properties ?? payload.dataStreams;
    if (raw !== undefined && !Array.isArray(raw)) throw new Error("Google Analytics paginated response was malformed.");
    for (const [index, entry] of (raw ?? []).entries()) entries.push(parse(entry, index));
    pageToken = nonEmptyString(payload.nextPageToken) ? payload.nextPageToken.trim() : undefined;
  } while (pageToken);
  return entries;
}

/** List Analytics accounts, exposing only resource IDs and safe labels. */
export async function listAccounts(): Promise<AnalyticsAccount[]> {
  return (await listPaged("/accounts", parseAccount)).sort((left, right) => left.name.localeCompare(right.name));
}

/** List properties, optionally restricted to one exact account resource. */
export async function listProperties(account?: string): Promise<AnalyticsProperty[]> {
  let path = "/properties";
  if (account !== undefined) {
    const parent = accountResource(account);
    path += `?filter=${encodeURIComponent(`parent:${parent}`)}`;
  }
  return (await listPaged(path, parseProperty)).sort((left, right) => left.name.localeCompare(right.name));
}

/** List data streams for one exact property. */
export async function listStreams(property: string): Promise<AnalyticsDataStream[]> {
  const parent = propertyResource(property);
  return (await listPaged(`/${parent}/dataStreams`, parseStream)).sort((left, right) => left.name.localeCompare(right.name));
}

function safeDisplayName(value: string, label: string): string {
  const result = safeLabel(value);
  if (!result || result === "[redacted label]") throw new Error(`${label} must be a non-email text value.`);
  return result;
}

function safeTimeZone(value: string): string {
  const result = value.trim();
  if (!/^[A-Za-z0-9_+./-]+$/.test(result) || result.length > 100) throw new Error("time-zone must be a valid IANA-style value.");
  return result;
}

function safeCurrency(value: string): string {
  const result = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(result)) throw new Error("currency-code must be a three-letter ISO 4217 code.");
  return result;
}

function safeIndustry(value: string): string {
  const result = value.trim().toUpperCase();
  if (!/^[A-Z_]+$/.test(result)) throw new Error("industry-category must contain uppercase letters and underscores only.");
  return result;
}

function safeUri(value: string): string {
  const result = value.trim();
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    throw new Error("default-uri must be an absolute HTTP(S) URL.");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("default-uri must be an HTTP(S) URL without credentials, query, or fragment.");
  }
  return result;
}

/** Create a property after the caller has explicitly approved the mutation. */
export async function createProperty(input: CreatePropertyInput): Promise<AnalyticsProperty> {
  const parent = accountResource(input.account);
  const body = {
    parent,
    displayName: safeDisplayName(input.displayName, "display-name"),
    industryCategory: safeIndustry(input.industryCategory ?? "OTHER"),
    timeZone: safeTimeZone(input.timeZone),
    currencyCode: safeCurrency(input.currencyCode),
  };
  return parseProperty(await request<unknown>(ADMIN_API_BASE, "/properties", {
    method: "POST",
    body: JSON.stringify(body),
  }), 0);
}

/** Create a web data stream after the caller has explicitly approved the mutation. */
export async function createWebStream(input: CreateWebStreamInput): Promise<AnalyticsDataStream> {
  const parent = propertyResource(input.property);
  const body = {
    displayName: safeDisplayName(input.displayName, "display-name"),
    type: "WEB_DATA_STREAM",
    webStreamData: { defaultUri: safeUri(input.defaultUri) },
  };
  return parseStream(await request<unknown>(ADMIN_API_BASE, `/${parent}/dataStreams`, {
    method: "POST",
    body: JSON.stringify(body),
  }), 0);
}

function eventNameInput(value: string): string {
  const result = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(result)) {
    throw new Error("event-name must be 1 to 40 letters, numbers, or underscores and start with a letter.");
  }
  return result;
}

function parseReport(payload: unknown, range: DateRange, propertyId: string, eventName: string): AnalyticsReport {
  if (!isRecord(payload)) throw new Error("Google Analytics report response was malformed.");
  const rows = payload.rows;
  if (rows !== undefined && !Array.isArray(rows)) throw new Error("Google Analytics report response was malformed.");
  let totalEvents = 0;
  for (const [index, row] of (rows ?? []).entries()) {
    if (!isRecord(row) || !Array.isArray(row.metricValues) || row.metricValues.length < 1) {
      throw new Error(`Google Analytics report response was malformed at row ${index}.`);
    }
    const value = row.metricValues[0];
    const raw = isRecord(value) ? value.value : undefined;
    if (!nonEmptyString(raw) || !/^\d+(?:\.\d+)?$/.test(raw.trim())) {
      throw new Error(`Google Analytics report response was malformed at row ${index}.`);
    }
    const count = Number(raw);
    if (!Number.isFinite(count) || count < 0) throw new Error(`Google Analytics report response was malformed at row ${index}.`);
    totalEvents += count;
  }
  if (!Number.isSafeInteger(totalEvents)) throw new Error("Google Analytics report total was invalid.");
  return { propertyId, eventName, totalEvents, ...range, sourceHealthy: true };
}

function parseVisitorsReport(payload: unknown, range: DateRange, propertyId: string): AnalyticsVisitorsReport {
  if (!isRecord(payload)) throw new Error("Google Analytics visitors report response was malformed.");

  const rowCount = payload.rowCount;
  if (rowCount !== undefined && (!Number.isSafeInteger(rowCount) || (rowCount as number) < 0)) {
    throw new Error("Google Analytics visitors report response was malformed.");
  }

  const metricHeaders = payload.metricHeaders;
  const rows = payload.rows;
  const dimensionHeaders = payload.dimensionHeaders;
  if (dimensionHeaders !== undefined && (
    !Array.isArray(dimensionHeaders) ||
    dimensionHeaders.length > 0
  )) {
    throw new Error("Google Analytics visitors report must not contain dimensions.");
  }

  // The GA4 API uses protoJSON. When an aggregate has no rows, the repeated
  // fields may both be omitted. Require the response's fixed kind and its
  // metadata object before accepting that representation as a healthy zero.
  if (
    metricHeaders === undefined &&
    rows === undefined &&
    (rowCount === undefined || rowCount === 0) &&
    payload.kind === "analyticsData#runReport" &&
    isRecord(payload.metadata)
  ) {
    return { propertyId, metric: "totalUsers", totalUsers: 0, ...range, sourceHealthy: true };
  }
  if (!Array.isArray(metricHeaders)) {
    throw new Error("Google Analytics visitors report is missing its metric header.");
  }
  if (metricHeaders.length !== 1 || !isRecord(metricHeaders[0]) || metricHeaders[0].name !== "totalUsers") {
    throw new Error("Google Analytics visitors report metric header was malformed.");
  }

  // ProtoJSON omits repeated fields when they are empty. With the required
  // metric header and an absent/zero rowCount, an omitted rows field is the
  // valid empty report shape rather than an API failure.
  if (rows === undefined) {
    if (rowCount !== undefined && rowCount !== 0) throw new Error("Google Analytics visitors report response was malformed.");
    return { propertyId, metric: "totalUsers", totalUsers: 0, ...range, sourceHealthy: true };
  }
  if (!Array.isArray(rows)) throw new Error("Google Analytics visitors report response was malformed.");
  if (rowCount !== undefined && rowCount !== rows.length) throw new Error("Google Analytics visitors report response was malformed.");
  if (rows.length > 1) throw new Error("Google Analytics visitors report must contain one aggregate row.");

  if (rows.length === 0) return { propertyId, metric: "totalUsers", totalUsers: 0, ...range, sourceHealthy: true };

  const row = rows[0];
  if (!isRecord(row) || "dimensionValues" in row || !Array.isArray(row.metricValues) || row.metricValues.length !== 1) {
    throw new Error("Google Analytics visitors report response was malformed.");
  }
  const value = row.metricValues[0];
  const raw = isRecord(value) ? value.value : undefined;
  if (!nonEmptyString(raw) || !/^\d+$/.test(raw.trim())) {
    throw new Error("Google Analytics visitors report response was malformed.");
  }
  const totalUsers = Number(raw);
  if (!Number.isSafeInteger(totalUsers) || totalUsers < 0) {
    throw new Error("Google Analytics visitors report total was invalid.");
  }
  return { propertyId, metric: "totalUsers", totalUsers, ...range, sourceHealthy: true };
}

/** Query one aggregate event count over an inclusive date range with no dimensions. */
export async function reportEvent(
  property: string,
  eventName: string,
  days: number,
  endDate?: string,
): Promise<AnalyticsReport> {
  const propertyId = resourceId(property, "properties", "property");
  const safeEventName = eventNameInput(eventName);
  const range = dateRange(days, endDate);
  const body = {
    dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
    metrics: [{ name: "eventCount" }],
    dimensionFilter: {
      filter: {
        fieldName: "eventName",
        stringFilter: { matchType: "EXACT", value: safeEventName },
      },
    },
  };
  return parseReport(await request<unknown>(DATA_API_BASE, `/properties/${propertyId}:runReport`, {
    method: "POST",
    body: JSON.stringify(body),
  }), range, propertyId, safeEventName);
}

/** Query distinct users over an inclusive date range with no dimensions. */
export async function reportVisitors(
  property: string,
  days: number,
  endDate?: string,
): Promise<AnalyticsVisitorsReport> {
  const propertyId = resourceId(property, "properties", "property");
  const range = dateRange(days, endDate);
  const body = {
    dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
    metrics: [{ name: "totalUsers" }],
  };
  return parseVisitorsReport(await request<unknown>(DATA_API_BASE, `/properties/${propertyId}:runReport`, {
    method: "POST",
    body: JSON.stringify(body),
  }), range, propertyId);
}

/** Test-only cache reset; no production command exposes credentials or tokens. */
export function resetForTests(): void {
  tokenCache = null;
}

/** Test-only export for validating event-name handling without a network call. */
export function validateEventName(value: string): string {
  return eventNameInput(value);
}

/** Test-only export for validating stream resource handling without a network call. */
export function validateStreamResource(value: string): string {
  return streamResource(value);
}
