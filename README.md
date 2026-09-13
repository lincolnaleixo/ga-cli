# ga-cli

`ga-cli` is a Bun/TypeScript command-line client for Google Analytics 4. It
lists accessible accounts, properties, and web data streams; produces small
aggregate reports; creates properties and streams; and supports OAuth
refresh-token onboarding.

## Install

Requirements:

- [Bun](https://bun.sh/)
- A Google Cloud OAuth client suitable for a local/desktop application
- A secret broker or another secure environment-variable injector

From a checkout of this repository:

```bash
bun install
chmod +x bin/ga-cli
bun run check
```

Use `bin/ga-cli` directly, or install the package with Bun so the `ga-cli`
binary is available on `PATH`:

```bash
bun add --global /path/to/ga-cli
ga-cli help
```

## Commands

All resource identifiers accept either a bare numeric ID or the corresponding
Google Analytics resource name (for example, `123` or `properties/123`).

### `help`

Print command and option reference:

```bash
ga-cli help
```

### `accounts`

List accounts accessible to the authenticated user. Add `--json` for a JSON
array:

```bash
ga-cli accounts [--json]
```

### `properties`

List accessible properties, optionally restricted to one account:

```bash
ga-cli properties [account] [--json]
```

### `streams`

List data streams for one property:

```bash
ga-cli streams <property> [--json]
```

### `report`

Return the total event count for one event name across an inclusive date
range. `--days` is required and must be 1–365. Without `--end-date`, the
range ends today:

```bash
ga-cli report <property> <event-name> --days <1-365> [--end-date YYYY-MM-DD] [--json]
```

Only the `eventName` dimension filter and `eventCount` metric are requested;
raw rows and dimensions are not returned.

### `report-visitors`

Return the aggregate distinct-user count for an inclusive date range:

```bash
ga-cli report-visitors <property> --days <1-365> [--end-date YYYY-MM-DD] [--json]
```

The command requests only `totalUsers` for the full range. It does not request
daily rows, dimensions, or user identifiers.

### `create-property`

Create a Google Analytics property. This is a mutation and requires
`--confirm`, plus all three required options:

```bash
ga-cli create-property <account> --confirm \
  --display-name "Example site" --time-zone UTC --currency-code USD \
  [--industry-category CATEGORY] [--json]
```

The industry category, when supplied, uses uppercase letters and underscores.
There is intentionally no delete command.

### `create-stream`

Create a web data stream. This is a mutation and requires `--confirm`:

```bash
ga-cli create-stream <property> --confirm \
  --display-name "Example web" --default-uri https://example.com [--json]
```

### `onboard`

Run the OAuth authorization-code flow, receive an offline refresh token, and
store it through the configured secret broker. This changes secret-manager
state and requires `--confirm`:

```bash
ga-cli onboard --confirm [--port PORT] [--redirect-uri URI] \
  [--timeout-seconds 30-900] [--no-browser]
```

The flow uses state validation, S256 PKCE, and a loopback HTTP callback. Use
`--no-browser` when the browser must be opened manually. If using a fixed
port or redirect URI, register that exact loopback URI in the OAuth client
configuration. The OAuth consent must grant both the read-only and edit
Google Analytics scopes required by the command set.

## Environment and OAuth setup

The reporting commands require these environment variables at runtime:

- `GOOGLE_ANALYTICS_CLIENT_ID` — OAuth client ID.
- `GOOGLE_ANALYTICS_CLIENT_SECRET` — OAuth client secret.
- `GOOGLE_ANALYTICS_REFRESH_TOKEN` — offline refresh token.
- `GOOGLE_ANALYTICS_TOKEN_URI` — optional HTTPS token endpoint; defaults to
  Google's standard OAuth token endpoint.

Do not commit a `.env` file, print these values, or pass them as command-line
arguments. Inject them from a secret broker or process supervisor. The OAuth
client ID and secret used for onboarding must be available without a refresh
token; onboarding writes the resulting refresh token to the broker. Then use
the same client configuration and stored refresh token for reporting.

After Google Cloud OAuth consent-screen and client setup, run onboarding with
the broker's documented environment injection command. A generic example is:

```bash
<secret-runner> --env GOOGLE_ANALYTICS_CLIENT_ID \
  --env GOOGLE_ANALYTICS_CLIENT_SECRET ga-cli onboard --confirm
```

The exact runner and secret names are deployment-specific. `ga-cli` never
prints access tokens, refresh tokens, client secrets, consent URLs, or raw API
payloads. Re-run onboarding if the refresh token is revoked or the granted
scopes need to change.

## Check

Run the type checker and the test suite:

```bash
bun run check
```

The tests use fake HTTP responses and do not require Google credentials or a
network connection.

## License

MIT. See [LICENSE](LICENSE).
