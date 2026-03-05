# Screen Reader Manual Matrix

Use this checklist when the automated audit raises structural issues or when the user explicitly needs real assistive-technology validation.

## Coverage Matrix

Test at least these combinations:

- `NVDA + Firefox` on Windows for baseline standards coverage.
- `JAWS + Chrome` on Windows for common enterprise usage.
- `VoiceOver + Safari` on macOS for Apple platform behavior.
- `TalkBack + Chrome` on Android for mobile screen-reader coverage.

If time is limited, run `NVDA + Firefox` first and document which combinations were skipped.

## Core Journeys

Run these journeys for each target page or flow:

1. Page load and page title announcement.
2. Landmark navigation through banner, navigation, main, complementary, contentinfo.
3. Heading navigation from top to bottom.
4. Link list and button list review for clear names.
5. Form entry, validation, correction, and resubmission.
6. Dialog, menu, accordion, tabs, and route changes if present.
7. Status, toast, loading, and error announcements if the page updates dynamically.

## What To Record

For each defect, capture:

- Screen reader and browser combination.
- Exact page URL and state.
- Trigger steps.
- Expected announcement or navigation outcome.
- Actual announcement or behavior.
- Whether focus moved correctly.
- Whether the issue reproduces in more than one screen reader.

## Repro Steps By Feature Area

### Page Load

- Confirm the page title is announced and matches the visible page purpose.
- Confirm focus lands in a sensible place and does not jump unexpectedly.
- Use heading navigation to verify the first meaningful heading can be reached quickly.

### Landmarks And Structure

- Use landmark shortcuts to confirm there is one clear main region.
- Confirm header, navigation, complementary, and footer landmarks are discoverable when present.
- Verify nested regions have meaningful labels if the screen reader exposes them.

### Links And Buttons

- Open the links list and listen for duplicate or vague names like `click here` or repeated `read more`.
- Open the buttons list and confirm icon buttons have meaningful names.
- Trigger buttons and confirm the resulting state change is announced or otherwise obvious.

### Forms

- Move field by field and confirm each input announces its label, role, state, and required status.
- Trigger validation intentionally and confirm the error is announced when it appears.
- Return to the invalid field and confirm the error remains associated with the field.
- Confirm autocomplete-relevant fields expose useful semantics where appropriate.

### Dynamic Updates

- Trigger modals and confirm focus moves into the dialog and returns after close.
- Trigger SPA route changes and confirm the new page context is announced.
- Trigger loading and error states and confirm live-region or focus behavior exposes them.
- Trigger toasts and transient messages and confirm they are announced without stealing focus unless necessary.

## Result Format

Use a compact table or bullet list:

- `PASS`: Behavior announced and navigable as expected.
- `FAIL`: Defect reproduced with clear steps and expected behavior.
- `PARTIAL`: Works in one screen reader or browser pair but not another.
- `NOT TESTED`: Combination or journey not covered.

## Limits

- Screen-reader testing still needs human judgment; do not convert this checklist into a binary compliance claim.
- Different verbosity, punctuation, and announcement order between screen readers are normal. Focus on whether the user can understand and complete the task.
