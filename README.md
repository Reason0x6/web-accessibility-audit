# Web Accessibility Audit Skill

URL-driven accessibility auditing with Playwright and axe-core.

This repo can:

- audit a single page
- crawl a small set of same-origin pages
- check keyboard navigation, screen-reader proxy structure, contrast, reflow, mobile touch targets, and form issues
- run scripted journeys for flow-specific checks
- apply project-specific rules from a requirements JSON file
- export JSON, Markdown, HTML, and CSV reports

## Setup

```powershell
npm install
npx playwright install chromium
```

## Quick Start

Single page audit:

```powershell
npm run audit -- --url https://example.com
```

Crawl:

```powershell
npm run crawl -- --url https://example.com --max-pages 5
```

With custom requirements:

```powershell
npm run audit -- --url http://localhost:4200/ --requirements-file scripts/examples/localhost-requirements.json
```

## Commands

Audit a page:

```powershell
node scripts/audit-url.mjs --url <page-url> [--out reports/name] [--requirements-file path/to/requirements.json] [--journey-file path/to/journey.json]
```

Crawl a site:

```powershell
node scripts/crawl-site.mjs --url <seed-url> [--max-pages 5] [--out reports/name] [--requirements-file path/to/requirements.json]
```

Useful flags:

- `--skip-reflow-check`
- `--reflow-widths 320,768`
- `--skip-mobile-check`
- `--mobile-viewports 390x844,360x800`
- `--skip-screenshots`
- `--screenshot-limit 10`
- `--tab-limit 25`
- `--timeout 45000`
- `--wait 1000`

## Outputs

Each run writes:

- `<base>.json`
- `<base>.md`
- `<base>.html`
- `<base>.csv`

If screenshots are enabled, it also writes:

- `<base>-assets/`

## Custom Requirements

Use `--requirements-file` to load:

- default run settings
- scoped selector/text/attribute rules
- scoped custom journeys
- axe severity overrides

Reference:

- [requirements-config.md](./references/requirements-config.md)
- [localhost-requirements.json](./scripts/examples/localhost-requirements.json)

## Scripted Journeys

Use `--journey-file` for flow-specific checks like route changes, validation, and state transitions.

Examples:

- [keyboard-home-to-tp7.json](./scripts/examples/keyboard-home-to-tp7.json)
- [tp7-invalid-url-state.json](./scripts/examples/tp7-invalid-url-state.json)

## Manual References

- [SKILL.md](./SKILL.md)
- [screen-reader-manual-matrix.md](./references/screen-reader-manual-matrix.md)

## Notes

- Automated checks are useful coverage, not a full accessibility certification.
- Real screen-reader validation still needs manual testing.
