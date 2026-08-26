# pi-extensions

Monorepo for Pi extensions built on [Herdr](https://herdr.dev). Each package under [`packages/`](packages/) is published to npm independently and installs as a Pi package.

## Packages

| Package | Description |
| --- | --- |
| [`pi-herdr-background-terminal`](packages/pi-herdr-background-terminal) | Run shell commands in persistent Herdr terminal panes and expose their lifecycle through `background_*` tools. |
| [`pi-herdr-subagent`](packages/pi-herdr-subagent) | Run delegated Pi agents in persistent Herdr panes through `pi-herdr-background-terminal` (`subagent_*` tools). |

## Install

```bash
pi install npm:pi-herdr-background-terminal
pi install npm:pi-herdr-subagent
```

See each package's README for features, tool reference, and configuration.

## Development

Requires Node 22+, pnpm, and [Bun](https://bun.sh) (test runner).

```bash
pnpm install
pnpm test
```

The Herdr-backed integration suite runs against a local Unix-socket mock server:

```bash
cd packages/pi-herdr-background-terminal && bun service.integration.ts
```

## Releasing

Packages version independently. To publish a package, tag the tip of `main` with `<package-name>-v<version>` and push the tag; GitHub Actions publishes the matching workspace to npm.

```bash
git tag pi-herdr-background-terminal-v0.1.3
git push origin pi-herdr-background-terminal-v0.1.3
```

## License

[MIT](LICENSE)
