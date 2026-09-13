import { afterEach, describe, expect, test } from "bun:test";
import {
  ANALYTICS_SCOPE,
  ANALYTICS_SCOPES,
  AUTHORIZATION_URI,
  CALLBACK_PATH,
  START_PATH,
  VAULT_REFRESH_TOKEN_REFERENCE,
  buildConsentUrl,
  bootstrapConfigFromEnv,
  callbackPathFromRedirectUri,
  createPkcePair,
  exchangeAuthorizationCode,
  pkceChallenge,
  runOAuthOnboarding,
  setRefreshTokenInVault,
  type BootstrapConfig,
  type HttpHandler,
  type LoopbackServer,
  type VaultSetProcess,
  validateRedirectUri,
} from "./oauth.ts";

const TOKEN_URI = "https://oauth2.example.test/token";
const CLIENT_ID = "fixture-analytics-client.apps.googleusercontent.com";
const CLIENT_SECRET = "fixture-analytics-client-secret";
const REFRESH_TOKEN = "fixture-analytics-refresh-token";
const AUTH_CODE = "fixture-authorization-code";
const REDIRECT_URI = "http://127.0.0.1:43817/oauth/callback";
const config: BootstrapConfig = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokenUri: TOKEN_URI };

let fakeServer: { handler: HttpHandler; port: number; closed: boolean } | null = null;

function fakeServerFactory(handler: HttpHandler, port: number): LoopbackServer {
  const state = { handler, port: port || 43817, closed: false };
  fakeServer = state;
  return { port: state.port, close: () => { state.closed = true; } };
}

function env(): Record<string, string> {
  return {
    GOOGLE_ANALYTICS_CLIENT_ID: CLIENT_ID,
    GOOGLE_ANALYTICS_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_ANALYTICS_TOKEN_URI: TOKEN_URI,
  };
}

function randomBytesFactory(): (length: number) => Uint8Array {
  let call = 0;
  return (length) => new Uint8Array(length).fill(++call);
}

function tokenResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function byteStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); controller.close(); } });
}

async function waitForFakeServer(): Promise<NonNullable<typeof fakeServer>> {
  for (let attempt = 0; attempt < 20 && !fakeServer; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  if (!fakeServer) throw new Error("test server was not created");
  return fakeServer;
}

afterEach(() => { fakeServer = null; });

describe("Google Analytics OAuth security", () => {
  test("requires bootstrap-only credentials and requests both minimum scopes", () => {
    expect(ANALYTICS_SCOPES).toEqual([
      "https://www.googleapis.com/auth/analytics.readonly",
      "https://www.googleapis.com/auth/analytics.edit",
    ]);
    expect(() => bootstrapConfigFromEnv({ ...env(), GOOGLE_ANALYTICS_REFRESH_TOKEN: REFRESH_TOKEN })).toThrow("bootstrap Vault profile without a refresh token");
    expect(() => bootstrapConfigFromEnv({ ...env(), GOOGLE_ANALYTICS_TOKEN_URI: "https://user:password@example.test/token?secret=value" })).toThrow("without embedded credentials or query data");
    const url = new URL(buildConsentUrl(config, REDIRECT_URI, { state: "state", challenge: "challenge" }));
    expect(url.origin + url.pathname).toBe(AUTHORIZATION_URI);
    expect(url.searchParams.get("scope")).toBe(ANALYTICS_SCOPE);
    expect(url.searchParams.get("scope")).toContain("analytics.readonly");
    expect(url.searchParams.get("scope")).toContain("analytics.edit");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.toString()).not.toContain(CLIENT_SECRET);
    expect(url.toString()).not.toContain(REFRESH_TOKEN);
  });

  test("creates S256 PKCE and validates exact loopback redirects", async () => {
    await expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const pair = await createPkcePair(randomBytesFactory());
    expect(pair.state).toHaveLength(43);
    expect(pair.verifier).toHaveLength(43);
    expect(pair.state).not.toBe(pair.verifier);
    expect(validateRedirectUri("http://localhost:8888/callback")).toBe("http://localhost:8888/callback");
    expect(callbackPathFromRedirectUri("http://localhost:8888/callback")).toBe("/callback");
    for (const value of ["", "https://localhost/callback", "http://example.test/callback", "http://localhost/start", "http://127.1/callback", "http://localhost/callback?x=1"]) {
      expect(() => validateRedirectUri(value), value).toThrow("loopback HTTP");
    }
  });
});

describe("Google Analytics OAuth exchange and onboarding", () => {
  test("exchanges code with PKCE and returns only the refresh token in memory", async () => {
    let requestBody = "";
    const refresh = await exchangeAuthorizationCode(AUTH_CODE, REDIRECT_URI, "verifier-value", config, (async (input, init) => {
      expect(String(input)).toBe(TOKEN_URI);
      requestBody = String(init?.body);
      return tokenResponse({ access_token: "fixture-access", refresh_token: REFRESH_TOKEN });
    }) as typeof fetch);
    const form = new URLSearchParams(requestBody);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(form.get("code_verifier")).toBe("verifier-value");
    expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(refresh).toBe(REFRESH_TOKEN);
  });

  test("uses state, PKCE, a value-free start URL and exact Vault stdin handoff", async () => {
    let consentUrl = "";
    let manualUrl = "";
    let stored = "";
    const onboarding = runOAuthOnboarding({
      env: env(), createServer: fakeServerFactory, randomBytes: randomBytesFactory(), noBrowser: true,
      showManualUrl: (url) => { manualUrl = url; },
      fetchImpl: (async (input, init) => {
        expect(String(input)).toBe(TOKEN_URI);
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
        expect(form.get("code_verifier")).toBeTruthy();
        return tokenResponse({ refresh_token: REFRESH_TOKEN });
      }) as typeof fetch,
      setRefreshToken: async (token) => { stored = token; }, timeoutMs: 1_000,
      port: 43817, redirectUri: REDIRECT_URI,
    });
    const server = await waitForFakeServer();
    const startResponse = await server.handler(new Request(manualUrl || `http://127.0.0.1:${server.port}${START_PATH}`));
    expect(startResponse.status).toBe(302);
    consentUrl = startResponse.headers.get("location")!;
    const consent = new URL(consentUrl);
    const state = consent.searchParams.get("state")!;
    expect(manualUrl).toBe(`http://127.0.0.1:${server.port}${START_PATH}`);
    expect(consent.searchParams.get("scope")).toBe(ANALYTICS_SCOPE);
    const callback = await server.handler(new Request(`http://127.0.0.1:${server.port}${CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=${AUTH_CODE}`));
    expect(callback.status).toBe(200);
    await expect(onboarding).resolves.toEqual({ redirectUri: REDIRECT_URI, manualUrlShown: true });
    expect(stored).toBe(REFRESH_TOKEN);
    expect(await callback.text()).not.toContain(REFRESH_TOKEN);
    expect(consentUrl).not.toContain(CLIENT_SECRET);
    expect(consentUrl).not.toContain(REFRESH_TOKEN);
  });

  test("rejects forged state and does not reflect OAuth/provider secrets", async () => {
    const onboarding = runOAuthOnboarding({
      env: env(), createServer: fakeServerFactory, randomBytes: randomBytesFactory(), openBrowser: async () => true,
      fetchImpl: (async () => tokenResponse({ refresh_token: REFRESH_TOKEN })) as unknown as typeof fetch,
      setRefreshToken: async () => undefined, timeoutMs: 1_000,
    });
    const server = await waitForFakeServer();
    const start = await server.handler(new Request(`http://127.0.0.1:${server.port}${START_PATH}`));
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const forged = await server.handler(new Request(`http://127.0.0.1:${server.port}${CALLBACK_PATH}?state=wrong&code=${AUTH_CODE}`));
    expect(forged.status).toBe(400);
    const valid = await server.handler(new Request(`http://127.0.0.1:${server.port}${CALLBACK_PATH}?state=${encodeURIComponent(state)}&error=access_denied&error_description=${encodeURIComponent(`${REFRESH_TOKEN} ${CLIENT_SECRET}`)}`));
    expect(valid.status).toBe(400);
    const error = await onboarding.catch((value: unknown) => value);
    expect(String(error)).toContain("consent was denied");
    expect(String(error)).not.toContain(REFRESH_TOKEN);
    expect(String(error)).not.toContain(CLIENT_SECRET);
  });
});

describe("Google Analytics Vault handoff", () => {
  test("uses fixed argv, writes token to stdin, drains child output and emits no logs", async () => {
    let args: string[] = [];
    let input = "";
    let options: unknown;
    const child: VaultSetProcess = {
      stdin: { write(value) { input += typeof value === "string" ? value : new TextDecoder().decode(value); }, end: () => undefined },
      stdout: byteStream(REFRESH_TOKEN), stderr: byteStream(REFRESH_TOKEN), exited: Promise.resolve(0),
    };
    await setRefreshTokenInVault(REFRESH_TOKEN, (nextArgs, nextOptions) => { args = nextArgs; options = nextOptions; return child; });
    expect(args).toEqual(["/home/robot/.local/bin/system-vault", "set", VAULT_REFRESH_TOKEN_REFERENCE, "--confirm"]);
    expect(input).toBe(`${REFRESH_TOKEN}\n`);
    expect(args.join(" ")).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(options)).toContain('"stdin":"pipe"');
  });
});
