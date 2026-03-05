# Requirements Config

Use `--requirements-file <path>` to load project-specific assessment rules without editing the skill code.

## Top-Level Shape

```json
{
  "name": "Project accessibility policy",
  "settings": {},
  "severityOverrides": {
    "axe": {
      "color-contrast": "critical"
    }
  },
  "rules": [],
  "journeys": []
}
```

## Supported Settings

These act as defaults unless the CLI explicitly overrides them:

- `tabLimit`
- `timeout`
- `wait`
- `reflowCheck`
- `reflowWidths`
- `mobileCheck`
- `mobileViewports`
- `screenshots`
- `screenshotLimit`
- `maxPages` for crawl mode

`mobileViewports` accepts either objects or strings like `390x844`.

## Supported Rule Types

Each rule may include:

- `id`
- `label`
- `type`
- `selector`
- `severity`
- `message`
- `timeout`
- `urlIncludes`
- `urlMatches`

Rule-specific fields:

- `selector_exists`
- `selector_absent`
- `selector_visible`
- `text_includes`
  Requires `selector` and `value`.
- `text_excludes`
  Requires `value`. If no selector is given, the body text is checked.
- `attribute_equals`
  Requires `selector`, `attribute`, and `value`.
- `attribute_includes`
  Requires `selector`, `attribute`, and `value`.
- `count_at_least`
  Requires `selector` and `min`.
- `count_at_most`
  Requires `selector` and `max`.
- `url_includes`
  Requires `value`.

## Journeys

Each journey entry can be inline or reference a JSON file:

```json
{
  "file": "./keyboard-home-to-tp7.json",
  "severity": "serious",
  "urlMatches": "http://localhost:4200/$"
}
```

Supported journey fields:

- `file`
- `name`
- `steps`
- `severity`
- `startUrl`
- `urlIncludes`
- `urlMatches`

Config journeys run on fresh pages so they do not interfere with the main audit state.

## Scope Controls

- `urlIncludes`: string or array of strings that must match the current page URL.
- `urlMatches`: regex string or array of regex strings tested against the current page URL.

These are useful for crawl mode, where some rules only apply to specific routes.
