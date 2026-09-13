import { afterEach, describe, expect, test } from "bun:test";
import * as analytics from "./client.ts";

const TOKEN_URI = "https://oauth2.example.test/token";
const CLIENT_ID = "fixture-analytics-client-id";
const CLIENT_SECRET = "fixture-analytics-client-secret";
const REFRESH_TOKEN = "fixture-analytics-refresh-token";
const ACCESS_TOKEN = "fixture-analytics-access-token";

const environment = [
  "GOOGLE_ANALYTICS_CLIENT_ID",
  "GOOGLE_ANALYTICS_CLIENT_SECRET",
  "GOOGLE_ANALYTICS_REFRESH_TOKEN",
  "GOOGLE_ANALYTICS_TOKEN_URI",
] as const;

const previousEnvironment = new Map<string, string | undefined>();
let previousFetch: typeof fetch;

function useCredentials(): void {
  for (const name of environment) previousEnvironment.set(name, process.env[name]);
  process.env.GOOGLE_ANALYTICS_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_ANALYTICS_CLIENT_SECRET = CLIENT_SECRET;
  process.env.GOOGLE_ANALYTICS_REFRESH_TOKEN = REFRESH_TOKEN;
  process.env.GOOGLE_ANALYTICS_TOKEN_URI = TOKEN_URI;
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600 }), { status: 200 });
}

function apiResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  globalThis.fetch = previousFetch;
  for (const name of environment) {
    const value = previousEnvironment.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previousEnvironment.clear();
  analytics.resetForTests();
});

describe("Google Analytics client with mocked OAuth and APIs", () => {
  test("lists accounts, properties, streams and reports one event without dimensions", async () => {
    previousFetch = globalThis.fetch;
    useCredentials();
    const requests: { method: string; url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ method: init?.method ?? "GET", url, init });
      if (url === TOKEN_URI) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("client_id")).toBe(CLIENT_ID);
        expect(form.get("client_secret")).toBe(CLIENT_SECRET);
        expect(form.get("refresh_token")).toBe(REFRESH_TOKEN);
        expect(form.get("grant_type")).toBe("refresh_token");
        return tokenResponse();
      }
      const parsed = new URL(url);
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${ACCESS_TOKEN}` });
      if (parsed.pathname === "/v1beta/accounts") {
        return apiResponse({ accounts: [{ name: "accounts/100", displayName: "MyCalc" }] });
      }
      if (parsed.pathname === "/v1beta/properties") {
        expect(parsed.searchParams.get("filter")).toBe("parent:accounts/100");
        return apiResponse({ properties: [{ name: "properties/200", parent: "accounts/100", displayName: "MyCalc Analytics", timeZone: "America/New_York", currencyCode: "USD", secretField: "must-not-escape" }] });
      }
      if (parsed.pathname === "/v1beta/properties/200/dataStreams") {
        return apiResponse({ dataStreams: [{ name: "properties/200/dataStreams/300", type: "WEB_DATA_STREAM", displayName: "MyCalc web", webStreamData: { measurementId: "G-ABC123", defaultUri: "https://mycalcexpert.com" }, privateField: "must-not-escape" }] });
      }
      if (parsed.pathname === "/v1beta/properties/200:runReport") {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({
          dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-03" }],
          metrics: [{ name: "eventCount" }],
          dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "calculate" } } },
        });
        expect(body).not.toHaveProperty("dimensions");
        return apiResponse({ rows: [{ metricValues: [{ value: "7" }], dimensionValues: [{ value: "private" }] }, { metricValues: [{ value: "2" }] }] });
      }
      return apiResponse({ error: { message: "not found" } }, 404);
    }) as unknown as typeof fetch;

    await expect(analytics.listAccounts()).resolves.toEqual([{ name: "accounts/100", accountId: "100", displayName: "MyCalc" }]);
    await expect(analytics.listProperties("accounts/100")).resolves.toEqual([{
      name: "properties/200",
      propertyId: "200",
      parent: "accounts/100",
      displayName: "MyCalc Analytics",
      timeZone: "America/New_York",
      currencyCode: "USD",
    }]);
    await expect(analytics.listStreams("200")).resolves.toEqual([{
      name: "properties/200/dataStreams/300",
      streamId: "300",
      propertyId: "200",
      displayName: "MyCalc web",
      type: "WEB_DATA_STREAM",
      measurementId: "G-ABC123",
      defaultUri: "https://mycalcexpert.com",
    }]);
    await expect(analytics.reportEvent("properties/200", "calculate", 3, "2026-09-03")).resolves.toEqual({
      propertyId: "200",
      eventName: "calculate",
      totalEvents: 9,
      startDate: "2026-09-01",
      endDate: "2026-09-03",
      sourceHealthy: true,
    });
    expect(requests.filter((request) => request.url === TOKEN_URI)).toHaveLength(1);
  });

  test("follows safe pagination and treats an empty report as healthy zero", async () => {
    previousFetch = globalThis.fetch;
    useCredentials();
    let propertyPage = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url === TOKEN_URI) return tokenResponse();
      const parsed = new URL(url);
      if (parsed.pathname === "/v1beta/properties") {
        propertyPage += 1;
        return propertyPage === 1
          ? apiResponse({ properties: [{ name: "properties/1", parent: "accounts/1" }], nextPageToken: "next-page" })
          : apiResponse({ properties: [{ name: "properties/2", parent: "accounts/1" }] });
      }
      if (parsed.pathname === "/v1beta/properties/1:runReport") return apiResponse({ rows: [] });
      return apiResponse({ properties: [] });
    }) as unknown as typeof fetch;
    await expect(analytics.listProperties()).resolves.toHaveLength(2);
    await expect(analytics.reportEvent("1", "calculate", 1, "2026-09-03")).resolves.toMatchObject({ totalEvents: 0, sourceHealthy: true });
  });

  test("reports one totalUsers aggregate across the inclusive range and accepts zero", async () => {
    previousFetch = globalThis.fetch;
    useCredentials();
    let reportCalls = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === TOKEN_URI) return tokenResponse();
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1beta/properties/200:runReport");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-30" }],
        metrics: [{ name: "totalUsers" }],
      });
      expect(body).not.toHaveProperty("dimensions");
      expect(body).not.toHaveProperty("dimensionFilter");
      reportCalls += 1;
      return reportCalls === 1
        ? apiResponse({ metricHeaders: [{ name: "totalUsers", type: "TYPE_INTEGER" }], rowCount: 1, rows: [{ metricValues: [{ value: "42" }] }] })
        : apiResponse({ kind: "analyticsData#runReport", metadata: {} });
    }) as unknown as typeof fetch;

    await expect(analytics.reportVisitors("properties/200", 30, "2026-09-30")).resolves.toEqual({
      propertyId: "200",
      metric: "totalUsers",
      totalUsers: 42,
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      sourceHealthy: true,
    });
    await expect(analytics.reportVisitors("200", 30, "2026-09-30")).resolves.toMatchObject({ totalUsers: 0, sourceHealthy: true });
    expect(reportCalls).toBe(2);
  });

  test("rejects visitor responses that are not one aggregate row", async () => {
    previousFetch = globalThis.fetch;
    useCredentials();
    const malformed = [
      { rows: [{ metricValues: [{ value: "1" }] }, { metricValues: [{ value: "2" }] }] },
      { rows: [{ metricValues: [{ value: "1" }] }] },
      { dimensionHeaders: [{ name: "date" }], rows: [] },
      { metricHeaders: [{ name: "totalUsers" }], rowCount: 1, rows: [] },
      { metricHeaders: [{ name: "totalUsers" }], rowCount: 0, rows: [{ metricValues: [{ value: "1" }] }] },
      { metricHeaders: [{ name: "totalUsers" }], rowCount: "0", rows: [] },
      { kind: "analyticsData#runReport", metadata: {}, rows: [{ metricValues: [{ value: "1" }] }] },
      { kind: "analyticsData#runReport" },
      { kind: "analyticsData#runReport", metadata: {}, dimensionHeaders: [{ name: "date" }] },
      { rows: [{ metricValues: [{ value: "1" }], dimensionValues: [] }] },
      { rows: [{ metricValues: [{ value: "1.5" }] }] },
      { rows: [{ metricValues: [{ value: "1" }, { value: "2" }] }] },
      {},
    ];
    for (const payload of malformed) {
      analytics.resetForTests();
      globalThis.fetch = (async (input: string | URL) => String(input) === TOKEN_URI ? tokenResponse() : apiResponse(payload)) as unknown as typeof fetch;
      await expect(analytics.reportVisitors("200", 1, "2026-09-30")).rejects.toThrow(/visitor report|visitors report|aggregate row|dimensions/);
    }
  });

  test("creates only the narrow property and web-stream payloads", async () => {
    previousFetch = globalThis.fetch;
    useCredentials();
    const requests: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === TOKEN_URI) return tokenResponse();
      requests.push({ url, init });
      if (new URL(url).pathname === "/v1beta/properties") return apiResponse({ name: "properties/901", parent: "accounts/100", displayName: "Created property", timeZone: "UTC", currencyCode: "USD", users: [{ email: "private@example.com" }] });
      return apiResponse({ name: "properties/901/dataStreams/902", type: "WEB_DATA_STREAM", displayName: "Created stream", webStreamData: { measurementId: "G-NEW123", defaultUri: "https://mycalcexpert.com" }, users: [{ email: "private@example.com" }] });
    }) as unknown as typeof fetch;

    await expect(analytics.createProperty({ account: "100", displayName: "Created property", timeZone: "UTC", currencyCode: "usd" })).resolves.toMatchObject({ name: "properties/901", propertyId: "901", parent: "accounts/100" });
    await expect(analytics.createWebStream({ property: "901", displayName: "Created stream", defaultUri: "https://mycalcexpert.com" })).resolves.toMatchObject({ name: "properties/901/dataStreams/902", measurementId: "G-NEW123" });
    const propertyBody = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(propertyBody).toEqual({ parent: "accounts/100", displayName: "Created property", industryCategory: "OTHER", timeZone: "UTC", currencyCode: "USD" });
    const streamBody = JSON.parse(String(requests[1]?.init?.body)) as Record<string, unknown>;
    expect(streamBody).toEqual({ displayName: "Created stream", type: "WEB_DATA_STREAM", webStreamData: { defaultUri: "https://mycalcexpert.com" } });
    expect(JSON.stringify(await analytics.createProperty({ account: "100", displayName: "owner@example.com", timeZone: "UTC", currencyCode: "USD" }).catch((error: unknown) => String(error)))).not.toContain("owner@example.com");
  });

  test("does not expose email-like labels or unrequested fields", async () => {
    previousFetch = globalThis.fetch;
    useCredentials();
    globalThis.fetch = (async (input: string | URL) => {
      if (String(input) === TOKEN_URI) return tokenResponse();
      return apiResponse({ accounts: [{ name: "accounts/1", displayName: "owner@example.com", email: "owner@example.com", secret: "private" }] });
    }) as unknown as typeof fetch;
    const accounts = await analytics.listAccounts();
    expect(accounts[0]?.displayName).toBe("[redacted label]");
    expect(JSON.stringify(accounts)).not.toContain("owner@example.com");
    expect(JSON.stringify(accounts)).not.toContain("private");
  });

  test("turns scope, auth and malformed responses into safe errors", async () => {
    previousFetch = globalThis.fetch;
    useCredentials();
    globalThis.fetch = (async (input: string | URL) => {
      if (String(input) === TOKEN_URI) return tokenResponse();
      return apiResponse({ error: { message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions", message: REFRESH_TOKEN }] } }, 403);
    }) as unknown as typeof fetch;
    const scopeError = await analytics.listAccounts().catch((value: unknown) => value);
    expect(String(scopeError)).toContain("analytics.readonly");
    expect(String(scopeError)).toContain("analytics.edit");
    expect(String(scopeError)).not.toContain(REFRESH_TOKEN);

    globalThis.fetch = (async (input: string | URL) => {
      if (String(input) === TOKEN_URI) return tokenResponse();
      return apiResponse({ accounts: "bad" });
    }) as unknown as typeof fetch;
    await expect(analytics.listAccounts()).rejects.toThrow("malformed");
    expect(() => analytics.dateRange(0)).toThrow("1 to 365");
    expect(() => analytics.dateRange(366)).toThrow("1 to 365");
    expect(() => analytics.dateRange(2, "2026-02-30")).toThrow("real calendar date");
    expect(() => analytics.validateEventName("owner@example.com")).toThrow("event-name");
    expect(() => analytics.validateStreamResource("properties/1/dataStreams/2")).not.toThrow();
    expect(() => analytics.validateStreamResource("dataStreams/2")).toThrow("resource name");
  });

  test("fails clearly when credentials were not injected", async () => {
    previousFetch = globalThis.fetch;
    for (const name of environment) delete process.env[name];
    await expect(analytics.listAccounts()).rejects.toThrow("GOOGLE_ANALYTICS_CLIENT_ID");
  });
});
