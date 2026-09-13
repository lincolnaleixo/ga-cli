import { describe, expect, test } from "bun:test";
import {
  accountSummary,
  assertAllowedFlags,
  assertMutationConfirmation,
  assertOnboardingConfirmation,
  parseArgs,
  propertySummary,
  reportSummary,
  streamSummary,
  usage,
  visitorsSummary,
} from "./cli.ts";

describe("Google Analytics CLI contract", () => {
  test("parses reporting and collection arguments and rejects unsafe flags", () => {
    expect(parseArgs(["report", "properties/123", "calculate", "--days", "90", "--end-date", "2026-09-03", "--json"])).toEqual({
      positional: ["report", "properties/123", "calculate"],
      flags: { days: "90", "end-date": "2026-09-03", json: true },
    });
    expect(parseArgs(["report-visitors", "properties/123", "--days", "30", "--end-date", "2026-09-30", "--json"])).toEqual({
      positional: ["report-visitors", "properties/123"],
      flags: { days: "30", "end-date": "2026-09-30", json: true },
    });
    expect(parseArgs(["properties", "accounts/12", "--json"])).toEqual({ positional: ["properties", "accounts/12"], flags: { json: true } });
    expect(() => parseArgs(["report", "123", "calculate", "--days"])).toThrow("requires a value");
    expect(() => parseArgs(["report", "123", "calculate", "--days", "1", "--days", "2"])).toThrow("duplicate flag");
    expect(() => assertAllowedFlags("accounts", { days: "90" })).toThrow("unknown flag");
    expect(() => assertMutationConfirmation({}, "create-property")).toThrow("--confirm");
    expect(() => assertMutationConfirmation({ confirm: true }, "create-property")).not.toThrow();
    expect(() => assertOnboardingConfirmation({})).toThrow("--confirm");
    expect(() => assertOnboardingConfirmation({ confirm: true })).not.toThrow();
  });

  test("documents the credential source, scope, aggregate boundary and no delete", () => {
    const text = usage();
    expect(text).toContain("GOOGLE_ANALYTICS_CREDENTIAL_COMMAND");
    expect(text).toContain("analytics.readonly");
    expect(text).toContain("analytics.edit");
    expect(text).toContain("--confirm");
    expect(text).toContain("no delete");
    expect(text).toContain("report-visitors");
    expect(text).toContain("totalUsers");
    expect(text).not.toContain("delete-property");
    expect(text).not.toContain("userId");
    expect(text).not.toContain("email");
  });

  test("projects only public resource IDs and aggregate fields", () => {
    const account = accountSummary({ name: "accounts/1", accountId: "1", displayName: "Example Account" });
    const property = propertySummary({ name: "properties/2", propertyId: "2", parent: "accounts/1", displayName: "Example Analytics", timeZone: "UTC", currencyCode: "USD" });
    const stream = streamSummary({ name: "properties/2/dataStreams/3", streamId: "3", propertyId: "2", type: "WEB_DATA_STREAM", displayName: "Example Web", measurementId: "G-ABC123", defaultUri: "https://example.test" });
    const report = reportSummary({ propertyId: "2", eventName: "calculate", totalEvents: 8, startDate: "2026-09-01", endDate: "2026-09-03", sourceHealthy: true });
    const visitors = visitorsSummary({ propertyId: "2", metric: "totalUsers", totalUsers: 12, startDate: "2026-09-01", endDate: "2026-09-30", sourceHealthy: true });
    expect(account).toEqual({ account: "accounts/1", accountId: "1", displayName: "Example Account" });
    expect(property).toMatchObject({ property: "properties/2", propertyId: "2", account: "accounts/1" });
    expect(stream).toMatchObject({ stream: "properties/2/dataStreams/3", measurementId: "G-ABC123" });
    expect(report).toEqual({ property: "properties/2", propertyId: "2", eventName: "calculate", totalEvents: 8, startDate: "2026-09-01", endDate: "2026-09-03", sourceHealthy: true });
    expect(visitors).toEqual({ property: "properties/2", propertyId: "2", metric: "totalUsers", totalUsers: 12, startDate: "2026-09-01", endDate: "2026-09-30", sourceHealthy: true });
    expect(JSON.stringify({ account, property, stream, report, visitors })).not.toContain("secret");
    expect(JSON.stringify(report)).not.toContain("dimensions");
    expect(JSON.stringify(visitors)).not.toContain("dimensions");
    expect(JSON.stringify(visitors)).not.toContain("userId");
  });
});
