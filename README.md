# Reins Extension

Chrome and Firefox extension for [Reins](https://reins.vulcanos.pro) — a bridge that lets any LLM client speaking the Model Context Protocol (MCP) drive your real, logged-in browser.

Real cookies. Real sessions. No re-login. No fresh cloud Chromium.

## Build

```sh
npm install
npm run build           # production bundle into ./chrome and ./firefox
npm run build:dev       # unminified
npm run build:watch     # rebuild on change
```

Outputs:

- `chrome/` — load as unpacked extension at `chrome://extensions`
- `firefox/` — load via `about:debugging` → "Load Temporary Add-on"

## Layout

- `src/background.ts` — MV3 service worker, handles MCP RPC
- `src/popup/` — pairing + status UI
- `src/rpc/` — tool dispatch
- `src/net.ts`, `src/network.ts`, `src/intercept.ts` — CDP network capture
- `src/manifest.chrome.json` — manifest source (build emits per-target)

## License

MIT — see [LICENSE](./LICENSE).
