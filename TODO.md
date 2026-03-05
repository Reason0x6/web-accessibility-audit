# Accessibility Skill Roadmap

Rank items by expected impact on real accessibility outcomes, signal quality, and feasibility for this skill.

## Ranked Backlog

1. `P1` Keyboard-only journey testing
Meaningfulness: Highest. Keyboard failures are common, severe, and only partially covered by the current tab-sampling heuristic.
Implementation direction: Add scripted journey support for menus, dialogs, forms, tabs, accordions, and other interactive flows.

2. `P1` Multi-page crawl and aggregation
Status: Implemented in this iteration.
Meaningfulness: Very high. Single-page audits miss repeated template defects and navigation-wide issues.
Implementation direction: Crawl a limited set of same-origin pages from nav links or a sitemap and aggregate defects.

3. `P1` Screenshots for each issue
Status: Implemented in this iteration.
Meaningfulness: Very high. Screenshots make results actionable and reduce time to reproduce.
Implementation direction: Capture page-level and element-level evidence for axe violations and key keyboard issues.

4. `P1` WCAG-mapped reporting by severity
Status: Implemented in this iteration.
Meaningfulness: Very high. Teams need findings grouped by severity and mapped to standards for triage and compliance.
Implementation direction: Add summarized WCAG tags, severity buckets, and remediation-ready report sections.

5. `P1` Zoom and reflow checks
Meaningfulness: Very high. Responsive breakage at 200 percent and 400 percent is common and often severe.
Implementation direction: Audit at enlarged scale and narrow widths for overflow, clipping, and horizontal scroll.

6. `P1` State-change testing
Meaningfulness: Very high. Focus management and announcements often fail during SPA navigation, dialogs, and live updates.
Implementation direction: Add a journey mode with explicit actions and assertions for focus and live regions.

7. `P1` Form accessibility checks
Meaningfulness: High. Forms are frequent sources of blocking defects.
Implementation direction: Expand label, required-state, autocomplete, and validation-message detection.

8. `P1` Contrast beyond text
Meaningfulness: High. Focus indicators, charts, icons, and UI states are easy to miss in text-only contrast checks.
Implementation direction: Add heuristics for focus-ring presence and non-text contrast candidates.

9. `P1` Real screen-reader testing
Meaningfulness: High, but partially outside browser-only automation.
Implementation direction: Document a manual test matrix for NVDA, JAWS, VoiceOver, and TalkBack with reproducible steps.

10. `P2` CSV and HTML exports
Meaningfulness: Medium-high. Reporting format improves adoption and sharing.
Implementation direction: Export aggregated findings in CSV and publish an HTML summary page.

11. `P2` Mobile accessibility checks
Meaningfulness: Medium-high. Important, but better after core desktop and journey coverage exist.
Implementation direction: Add touch-target and mobile viewport runs.

12. `P2` Motion and sensory checks
Meaningfulness: Medium. Valuable, but narrower than structure, keyboard, and forms.
Implementation direction: Check reduced-motion support, autoplay, flashing risk flags, and pause controls.

13. `P2` Content-quality heuristics
Meaningfulness: Medium. Useful for editorial issues but less deterministic.
Implementation direction: Flag weak link text, duplicate labels, heading anomalies, and table-header gaps.

14. `P2` Mobile screen-reader validation guidance
Meaningfulness: Medium. Best captured as a manual checklist rather than automation first.
Implementation direction: Add a manual reference workflow.

15. `P3` Authenticated-flow support
Meaningfulness: Context dependent. Very important for real apps, but not useful on a public demo target like `https://www.wsp.com`.
Implementation direction: Add reusable login hooks or storage-state support.

16. `P3` PDF and downloadable-document audits
Meaningfulness: Context dependent. Important when files are central to the site, but separate from core page automation.
Implementation direction: Detect linked documents and hand off to a dedicated file-audit workflow.

## Implementation Order For This Iteration

1. Multi-page crawl and aggregation
2. Screenshots for each issue
3. WCAG-mapped reporting by severity
4. If time remains: richer form checks or zoom/reflow checks
