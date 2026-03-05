---
name: web-accessibility-audit
description: Audit a live web page for accessibility issues from a URL. Use this skill when Codex needs to test keyboard navigation, focus visibility, screen-reader-relevant semantics, text contrast, WCAG A/AA violations, or produce an accessibility report for a public page.
---

# Web Accessibility Audit

Use the bundled audit script to test a live URL in Chromium with Playwright and axe-core. The script produces both JSON and Markdown output so the results can be reviewed directly or reused in follow-up work.

## Quick Start

From the skill directory:

```powershell
npm install
npx playwright install chromium
npm run audit -- --url https://example.com
npm run crawl -- --url https://www.wsp.com --max-pages 5
```

The script writes reports into `reports/` by default and prints the output paths to stdout.

## Workflow

1. Confirm the target page is reachable without credentials. If it is not, stop and ask for a reproducible public URL or a session setup plan.
2. Install dependencies if `node_modules/` is missing.
3. Run `npm run audit -- --url <page-url>`.
4. Use `npm run crawl -- --url <seed-url> --max-pages <n>` when the user needs repeated-template coverage across several same-origin pages.
5. Read the generated Markdown summary first, then inspect the JSON report for affected selectors and rule IDs.
6. Separate automated findings from manual follow-up. Treat keyboard and screen-reader checks as high-value heuristics, not full assistive-technology validation.

## Command Options

Run the script with:

```powershell
node scripts/audit-url.mjs --url <page-url> [--out reports/custom-name] [--tab-limit 25] [--timeout 45000] [--wait 1000] [--screenshots] [--screenshot-limit 10]
node scripts/crawl-site.mjs --url <seed-url> [--max-pages 5] [--out reports/site-crawl] [--tab-limit 25] [--timeout 45000] [--wait 1000] [--screenshots] [--screenshot-limit 10]
```

Supported options:

- `--url`: Required target URL. A positional URL also works.
- `--out`: Output base path without extension. The script writes `<base>.json` and `<base>.md`.
- `--tab-limit`: Maximum number of `Tab` presses to sample for keyboard traversal.
- `--timeout`: Navigation timeout in milliseconds.
- `--wait`: Extra post-load wait in milliseconds for client-rendered pages.
- `--max-pages`: Crawl mode only. Limit how many same-origin pages are audited from the seed URL.
- `--screenshots`: Save a full-page screenshot plus issue-focused evidence images.
- `--screenshot-limit`: Cap how many issue-focused screenshots are captured.

## What The Script Checks

- Axe WCAG and best-practice rules in Chromium.
- Keyboard traversal by simulating `Tab` and one reverse `Shift+Tab` step.
- Focus visibility heuristics for visited tab stops.
- Screen-reader proxy checks such as missing landmarks, heading skips, unlabeled controls, unnamed buttons or links, missing `lang`, and missing `alt`.
- Contrast findings from axe (`color-contrast`).
- Crawl aggregation across multiple same-origin pages, including repeated rule IDs and per-page summaries.

## Interpretation Rules

- Report axe violations as concrete defects unless the page state is obviously incomplete.
- Report keyboard traversal warnings as heuristics that still need manual confirmation on complex widgets, menus, dialogs, and SPAs.
- Report screen-reader proxy issues as structural accessibility problems. Do not claim that a real screen-reader experience has been fully validated unless a human tested with NVDA, JAWS, VoiceOver, or TalkBack.
- Keep contrast findings separate in the summary because they are usually straightforward to remediate.

## Limitations

- The script does not authenticate, solve CAPTCHAs, or traverse multi-step user journeys.
- It does not emulate a real screen reader's speech output or announcement timing.
- It samples keyboard order on one page state only. Dynamic states such as open menus, modals, and inline validation need manual follow-up.
- Highly interactive apps may need a larger `--wait` or custom setup before running the audit.
