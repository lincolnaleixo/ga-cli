# ga-cli

Google Analytics reporting CLI and API client

## Install

## Use

## License

MIT.
# ga-cli

A TypeScript CLI and client for Google Analytics reporting and OAuth onboarding.

## Install

Requires Bun. Clone this repository, run `bun install`, then run `bun run check`.

## Use

The executable is `./bin/ga-cli`. The default invocation is:

```bash
system-vault run google-analytics -- ./bin/ga-cli help
```

Commands: Run `./bin/ga-cli help` for the complete reporting, account, property, and OAuth command list. Reports accept explicit date ranges and metrics as shown by help.

## Environment

Credentials are read only from environment variables. Inject them with your organization's secret broker; never commit a `.env` file or put secret values in arguments.

`GOOGLE_ANALYTICS_CLIENT_ID`, `GOOGLE_ANALYTICS_CLIENT_SECRET`, `GOOGLE_ANALYTICS_REFRESH_TOKEN`, optional `GOOGLE_ANALYTICS_TOKEN_URI`.

## License

MIT. See [LICENSE](LICENSE).
