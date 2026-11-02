# Contributing to Trove

Bug reports, ideas and pull requests are all welcome. For anything large, open an issue first so we can agree on the shape before you build it.

## Set up

You need Node and Docker.

```bash
git clone https://github.com/anunay999/trove.git && cd trove
npm install
cp .env.example .env
npm run setup               # Postgres + schema + migrations
npm run dev:all             # API and dashboard with reload
```

[docs/development.md](docs/development.md) covers the architecture, the data model and the design rationale.

## Before you open a PR

```bash
npm run check               # typecheck + lint
npm test                    # against your local Postgres
TROVE_STORE=memory npm test # without Postgres
npm run web:build           # if you touched web/
```

- Keep each PR to one change, and say what it does and why.
- Add screenshots if the change is visible in the dashboard or on the site.
- Update `docs/` if behaviour, the MCP tools or the API changed.
- Never include secrets, tokens or real connection strings.

CI runs the same checks, and `main` requires a reviewed PR.

## Reporting a security problem

Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

Trove is licensed under the [GNU AGPL-3.0](LICENSE), and your contributions are made under the same license. Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
