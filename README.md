# Reins Extension

Chrome and Firefox extension for [Reins](https://reins.vulcanos.pro) — a bridge that lets any LLM client speaking the Model Context Protocol (MCP) drive your real, logged-in browser.

Real cookies. Real sessions. No re-login.

## Build

```sh
npm install
npm run build           # production
npm run build:dev       # unminified
npm run build:watch     # rebuild on change
```

Outputs:

- `chrome/` — load as unpacked at `chrome://extensions`
- `firefox/` — load via `about:debugging` → "Load Temporary Add-on"

## License

MIT — see [LICENSE](./LICENSE).
