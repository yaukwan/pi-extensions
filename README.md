# pi-extensions

Monorepo for Pi extensions built on [Herdr](https://herdr.dev). Each package under [`packages/`](packages/) is published to npm independently and installs as a Pi package.

## Packages

| Package | Description | Install |
| --- | --- | --- |
| [`pi-herdr-background-terminal`](packages/pi-herdr-background-terminal) | Run shell commands in persistent Herdr terminal panes and expose their lifecycle through `background_*` tools. | `pi install npm:pi-herdr-background-terminal` |
| [`pi-herdr-subagent`](packages/pi-herdr-subagent) | Run delegated Pi agents in persistent Herdr panes through `pi-herdr-background-terminal` (`subagent_*` tools). | `pi install npm:pi-herdr-subagent` |

See each package's README for features, tool reference, and configuration.

## Development

Requires Node 22.7+ and pnpm.

```bash
pnpm install
pnpm test
```

The Herdr-backed integration suite runs against a local Unix-socket mock server:

```bash
cd packages/pi-herdr-background-terminal && node --experimental-transform-types service.integration.ts
```

## License

[MIT](LICENSE)
