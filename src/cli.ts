#!/usr/bin/env bun
import * as analytics from "./client.ts";
import { runOAuthOnboarding } from "./oauth.ts";
import type {
  AnalyticsAccount,
  AnalyticsDataStream,
  AnalyticsProperty,
  AnalyticsReport,
  AnalyticsVisitorsReport,
} from "./types.ts";

type FlagValue = string | boolean;

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, FlagValue>;
}

const BOOLEAN_FLAGS = new Set(["json", "confirm", "no-browser"]);
const COMMANDS = new Set([
  "accounts",
  "properties",
  "streams",
  "report",
  "report-visitors",
  "create-property",
  "create-stream",
  "onboard",
  "help",
]);
const ALLOWED_FLAGS: Record<string, ReadonlySet<string>> = {
  accounts: new Set(["json"]),
  properties: new Set(["json"]),
  streams: new Set(["json"]),
  report: new Set(["days", "end-date", "json"]),
  "report-visitors": new Set(["days", "end-date", "json"]),
  "create-property": new Set(["confirm", "display-name", "time-zone", "currency-code", "industry-category", "json"]),
  "create-stream": new Set(["confirm", "display-name", "default-uri", "json"]),
  onboard: new Set(["confirm", "no-browser", "port", "redirect-uri", "timeout-seconds"]),
  help: new Set(),
};

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

export function parseArgs(input: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]!;
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const key = item.slice(2);
    if (!key) throw new CliError("empty flag");
    if (key in flags) throw new CliError(`duplicate flag: --${key}`);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = input[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError(`--${key} requires a value`);
    flags[key] = value;
    index += 1;
  }
  return { positional, flags };
}

export function assertAllowedFlags(command: string, flags: Record<string, FlagValue>): void {
  const allowed = ALLOWED_FLAGS[command];
  if (!allowed) throw new CliError(`unknown command: ${command}\n\n${usage()}`);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new CliError(`unknown flag for ${command}: --${key}`);
  }
}

function flagString(flags: Record<string, FlagValue>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function hasFlag(flags: Record<string, FlagValue>, name: string): boolean {
  return flags[name] === true;
}

export function assertMutationConfirmation(flags: Record<string, FlagValue>, operation: string): void {
  if (!hasFlag(flags, "confirm")) throw new CliError(`${operation} requires explicit --confirm because it changes Google Analytics.`);
}

export function assertOnboardingConfirmation(flags: Record<string, FlagValue>): void {
  if (!hasFlag(flags, "confirm")) throw new CliError("onboard requires explicit --confirm because it creates or rotates a credential");
}

function required(positionals: string[], index: number, label: string): string {
  const value = positionals[index];
  if (!value) throw new CliError(`missing ${label}`);
  return value;
}

function requiredFlag(flags: Record<string, FlagValue>, name: string): string {
  const value = flagString(flags, name);
  if (!value?.trim()) throw new CliError(`missing --${name}`);
  return value;
}

function assertArity(positionals: string[], minimum: number, maximum: number, syntax: string): void {
  if (positionals.length < minimum || positionals.length > maximum) throw new CliError(`usage: ${syntax}`);
}

function parseDays(flags: Record<string, FlagValue>): number {
  const raw = flagString(flags, "days");
  if (raw === undefined) throw new CliError("missing --days (an integer from 1 to 365 is required)");
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new CliError("--days must be an integer from 1 to 365");
  return days;
}

function parseBoundedInteger(
  flags: Record<string, FlagValue>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new CliError(`--${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function optionalFields(fields: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Safe account projection; raw API payload and account-user details are omitted. */
export function accountSummary(account: AnalyticsAccount): Record<string, string> {
  return optionalFields({ account: account.name, accountId: account.accountId, displayName: account.displayName });
}

/** Safe property projection; raw API payload and user details are omitted. */
export function propertySummary(property: AnalyticsProperty): Record<string, string> {
  return optionalFields({
    property: property.name,
    propertyId: property.propertyId,
    account: property.parent,
    displayName: property.displayName,
    timeZone: property.timeZone,
    currencyCode: property.currencyCode,
  });
}

/** Safe stream projection; measurement IDs are public, but API payload is not returned. */
export function streamSummary(stream: AnalyticsDataStream): Record<string, string> {
  return optionalFields({
    stream: stream.name,
    streamId: stream.streamId,
    property: `properties/${stream.propertyId}`,
    type: stream.type,
    displayName: stream.displayName,
    measurementId: stream.measurementId,
    defaultUri: stream.defaultUri,
  });
}

/** Safe aggregate projection; no dimensions, user, page, or raw rows. */
export function reportSummary(report: AnalyticsReport): Record<string, string | number | true> {
  return {
    property: `properties/${report.propertyId}`,
    propertyId: report.propertyId,
    eventName: report.eventName,
    totalEvents: report.totalEvents,
    startDate: report.startDate,
    endDate: report.endDate,
    sourceHealthy: report.sourceHealthy,
  };
}

/** Safe distinct-user projection; no dimensions, user IDs, or raw rows. */
export function visitorsSummary(report: AnalyticsVisitorsReport): Record<string, string | number | true> {
  return {
    property: `properties/${report.propertyId}`,
    propertyId: report.propertyId,
    metric: report.metric,
    totalUsers: report.totalUsers,
    startDate: report.startDate,
    endDate: report.endDate,
    sourceHealthy: report.sourceHealthy,
  };
}

export function usage(): string {
  return `Google Analytics aggregate administration

Usage: ga-cli <command> [args]

Commands:
  accounts [--json]                              List accessible accounts
  properties [account] [--json]                  List properties, optionally for one account
  streams <property> [--json]                    List data streams for one property
  report <property> <event-name> --days N        Aggregate one event name for 1 to 365 days
    --end-date YYYY-MM-DD                         Inclusive range end (defaults to today)
    --json                                         Emit only safe aggregate JSON
  report-visitors <property> --days N             Aggregate distinct users for 1 to 365 days
    --end-date YYYY-MM-DD                         Inclusive range end (defaults to today)
    --json                                         Emit only safe aggregate JSON
  create-property <account> --confirm             Create a property (mutation)
    --display-name TEXT --time-zone ZONE --currency-code ISO
    [--industry-category CATEGORY] [--json]
  create-stream <property> --confirm              Create a web data stream (mutation)
    --display-name TEXT --default-uri URL [--json]
  onboard --confirm [options]                     Obtain offline consent and store the refresh token
    --port N                                       Fixed loopback listener port
    --redirect-uri URI                             Exact registered loopback callback URI
    --timeout-seconds N                            Callback timeout from 30 to 900 seconds
    --no-browser                                  Show a local helper URL instead of opening a browser
  help                                             Show this help

The configured credential source must include analytics.readonly and analytics.edit.
Set GOOGLE_ANALYTICS_CREDENTIAL_COMMAND to a command that accepts
`set google-analytics.refresh-token --confirm` and reads the token from stdin.
OAuth uses state, S256 PKCE, a 127.0.0.1 listener, and a value-free /start
helper URL. It never prints the consent URL or any token. Mutations require
--confirm and there is no delete.
Reports use only the eventName filter and eventCount metric; no dimensions or
personal data are requested or returned. Visitor reports use only the totalUsers
metric over the full inclusive range; they never request dimensions, sum daily
rows, or return user identifiers/raw rows. Missing or unhealthy source data is
an error, never an assumed zero.`;
}

function printCollection<T>(items: T[], project: (item: T) => Record<string, unknown>, label: string, json: boolean): void {
  const safe = items.map(project);
  if (json) {
    console.log(JSON.stringify(safe, null, 2));
    return;
  }
  if (safe.length === 0) {
    console.log(`No accessible Google Analytics ${label} found`);
    return;
  }
  for (const entry of safe) console.log(JSON.stringify(entry));
  console.log(`\nTotal: ${safe.length}`);
}

function printReport(report: AnalyticsReport, json: boolean): void {
  const safe = reportSummary(report);
  if (json) {
    console.log(JSON.stringify(safe, null, 2));
    return;
  }
  console.log(`\nProperty:      ${safe.property}\nEvent:         ${safe.eventName}\nTotal events:  ${safe.totalEvents}\nDate range:    ${safe.startDate} through ${safe.endDate}\nSource healthy: yes`);
}

function printVisitorsReport(report: AnalyticsVisitorsReport, json: boolean): void {
  const safe = visitorsSummary(report);
  if (json) {
    console.log(JSON.stringify(safe, null, 2));
    return;
  }
  console.log(`\nProperty:      ${safe.property}\nMetric:        ${safe.metric}\nTotal users:   ${safe.totalUsers}\nDate range:    ${safe.startDate} through ${safe.endDate}\nSource healthy: yes`);
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
    const [rawCommand, ...args] = parsed.positional;
    const command = rawCommand?.toLowerCase() || "help";
    assertAllowedFlags(command, parsed.flags);
    if (!COMMANDS.has(command)) throw new CliError(`unknown command: ${command}\n\n${usage()}`);
    if (command === "help") {
      assertArity(args, 0, 0, "help");
      console.log(usage());
      return;
    }
    const json = hasFlag(parsed.flags, "json");
    switch (command) {
      case "accounts":
        assertArity(args, 0, 0, "accounts [--json]");
        printCollection(await analytics.listAccounts(), accountSummary, "accounts", json);
        return;
      case "properties":
        assertArity(args, 0, 1, "properties [account] [--json]");
        printCollection(await analytics.listProperties(args[0]), propertySummary, "properties", json);
        return;
      case "streams":
        assertArity(args, 1, 1, "streams <property> [--json]");
        printCollection(await analytics.listStreams(required(args, 0, "property")), streamSummary, "data streams", json);
        return;
      case "report":
        assertArity(args, 2, 2, "report <property> <event-name> --days N [--end-date YYYY-MM-DD] [--json]");
        printReport(await analytics.reportEvent(required(args, 0, "property"), required(args, 1, "event-name"), parseDays(parsed.flags), flagString(parsed.flags, "end-date")), json);
        return;
      case "report-visitors":
        assertArity(args, 1, 1, "report-visitors <property> --days N [--end-date YYYY-MM-DD] [--json]");
        printVisitorsReport(await analytics.reportVisitors(required(args, 0, "property"), parseDays(parsed.flags), flagString(parsed.flags, "end-date")), json);
        return;
      case "create-property":
        assertArity(args, 1, 1, "create-property <account> --confirm --display-name TEXT --time-zone ZONE --currency-code ISO [options]");
        assertMutationConfirmation(parsed.flags, "create-property");
        const createdProperty = await analytics.createProperty({
          account: required(args, 0, "account"),
          displayName: requiredFlag(parsed.flags, "display-name"),
          timeZone: requiredFlag(parsed.flags, "time-zone"),
          currencyCode: requiredFlag(parsed.flags, "currency-code"),
          industryCategory: flagString(parsed.flags, "industry-category"),
        });
        console.log(json ? JSON.stringify(propertySummary(createdProperty), null, 2) : JSON.stringify(propertySummary(createdProperty)));
        return;
      case "create-stream":
        assertArity(args, 1, 1, "create-stream <property> --confirm --display-name TEXT --default-uri URL [--json]");
        assertMutationConfirmation(parsed.flags, "create-stream");
        const createdStream = await analytics.createWebStream({
          property: required(args, 0, "property"),
          displayName: requiredFlag(parsed.flags, "display-name"),
          defaultUri: requiredFlag(parsed.flags, "default-uri"),
        });
        console.log(json ? JSON.stringify(streamSummary(createdStream), null, 2) : JSON.stringify(streamSummary(createdStream)));
        return;
      case "onboard":
        assertArity(args, 0, 0, "onboard --confirm [options]");
        assertOnboardingConfirmation(parsed.flags);
        const timeoutSeconds = parseBoundedInteger(parsed.flags, "timeout-seconds", 30, 900);
        await runOAuthOnboarding({
          port: parseBoundedInteger(parsed.flags, "port", 0, 65_535),
          redirectUri: flagString(parsed.flags, "redirect-uri"),
          timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
          noBrowser: hasFlag(parsed.flags, "no-browser"),
        });
        console.log("Google Analytics OAuth grant stored through the credential command.");
        return;
      default:
        throw new CliError(`unknown command: ${command}\n\n${usage()}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

if (import.meta.main) void main();
