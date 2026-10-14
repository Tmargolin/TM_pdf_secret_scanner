# PDF Secret Scanner

A Chrome extension (Manifest V3) that warns you when a PDF you add to a website
on your allow list contains secrets – API keys, tokens, private keys and
similar. The PDF's text is checked by the Prompt Security API; results appear
as Chrome notifications. **Uploads are never blocked** – the extension only
alerts.

> **Status:** in development (v0.1.0). This README is a skeleton and is
> completed in step 9 of the plan. Design and plan: [DESIGN.md](DESIGN.md).

## Requirements

- Google Chrome 120 or later
- Node.js 24 or later (for building and testing)

## Setup

```powershell
npm install
npx playwright install chromium   # browser for the test suite
```

## Build

| Command | Output |
|---|---|
| `npm run build` | Release build in `dist/` |
| `npm run build:dev` | Development build in `dist/` – additionally allows `http://localhost` (local test pages, mock API) |

## Load in Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → select the `dist` folder.
3. After rebuilding, click the reload icon on the extension card.

## Configuration

*Completed in step 3 (options page):* APP-ID, API URL, site allow list and all
settings with their defaults.

## Testing

| Command | What it runs |
|---|---|
| `npm run typecheck` | TypeScript type check |
| `npm test` | Unit tests – Node (`tests/unit`) and real Chromium (`tests/browser`) |
| `npm run test:coverage` | Tests with coverage; fails below 80 % for `src/scanner` and `src/shared` |
| `npm run audit` | Fails on high or critical dependency vulnerabilities |

CI (GitHub Actions) runs all of the above plus both builds on every push.

Manual tests (real API, real websites, OS notifications) follow
`docs/manual-tests.md` *(added in step 2)*.

**Planned:** automated end-to-end tests with Playwright – Chromium launched
with the extension loaded, local test pages and a mock API.

## Privacy and security (summary)

- The full text of PDFs added to allow-listed sites is sent to the Prompt
  Security API. Vendor-side retention is unknown.
- Incognito windows are not supported.
- Secrets and PDF text are kept in memory only; never stored or logged.
- Never commit your APP-ID.

*Full details completed in step 9.*

## Future options

- Event-listener safety net for upload detection
- Text clean-up before chunking
- Details page / recent-scans history
- Enterprise deployment via managed storage
- Per-tab rate limiting
- OCR for scanned PDFs, other file types
- Automated end-to-end tests with Playwright

## For developers and AI agents

- [DESIGN.md](DESIGN.md) – architecture, decisions, plan
- [AGENTS.md](AGENTS.md) – entry point for AI coding agents
