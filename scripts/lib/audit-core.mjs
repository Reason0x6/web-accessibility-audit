import fs from "node:fs/promises";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

export function slugifyUrl(rawUrl) {
  const url = new URL(rawUrl);
  const hostname = url.hostname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  const pathname = url.pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return [hostname, pathname].filter(Boolean).join("-") || "page";
}

export function timestampForFile(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function summarizeImpactCounts(violations) {
  return violations.reduce(
    (counts, violation) => {
      const impact = violation.impact || "unknown";
      counts[impact] = (counts[impact] || 0) + 1;
      return counts;
    },
    { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 },
  );
}

function trimText(value, length = 120) {
  if (!value) {
    return "";
  }

  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > length ? `${collapsed.slice(0, length - 1)}...` : collapsed;
}

function simplifyAxeResults(items) {
  return items.map((item) => ({
    id: item.id,
    impact: item.impact || "unknown",
    description: item.description,
    help: item.help,
    helpUrl: item.helpUrl,
    tags: item.tags,
    affectedNodes: item.nodes.length,
    nodes: item.nodes.slice(0, 10).map((node) => ({
      target: node.target,
      html: trimText(node.html, 160),
      failureSummary: trimText(node.failureSummary, 240),
    })),
  }));
}

function wcagTagsFor(tags) {
  return tags.filter((tag) => /^wcag/i.test(tag)).sort();
}

function buildSeverityBuckets(violations) {
  const buckets = {
    critical: [],
    serious: [],
    moderate: [],
    minor: [],
    unknown: [],
  };

  for (const violation of violations) {
    const bucket = buckets[violation.impact] || buckets.unknown;
    bucket.push({
      id: violation.id,
      affectedNodes: violation.affectedNodes,
      wcagTags: wcagTagsFor(violation.tags),
      help: violation.help,
    });
  }

  return buckets;
}

function buildWcagSummary(violations) {
  const counts = new Map();

  for (const violation of violations) {
    for (const tag of wcagTagsFor(violation.tags)) {
      counts.set(tag, (counts.get(tag) || 0) + violation.affectedNodes);
    }
  }

  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
}

function sanitizeFilePart(value) {
  return value.replace(/[^a-z0-9-_]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "item";
}

async function captureScreenshot(locator, filePath) {
  try {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.screenshot({ path: filePath });
    return true;
  } catch {
    return false;
  }
}

async function captureEvidence(page, axeViolations, keyboard, assetDir, screenshotLimit) {
  const evidence = {
    page: null,
    violations: [],
    keyboard: [],
  };

  await fs.mkdir(assetDir, { recursive: true });

  const pagePath = path.join(assetDir, "page.png");
  await page.screenshot({ path: pagePath, fullPage: true }).catch(() => {});
  evidence.page = path.relative(process.cwd(), pagePath);

  let screenshotCount = 0;
  for (const violation of axeViolations) {
    for (const node of violation.nodes) {
      if (screenshotCount >= screenshotLimit) {
        break;
      }

      const selector = Array.isArray(node.target) && node.target.length > 0 ? node.target[0] : null;
      if (!selector) {
        continue;
      }

      const screenshotPath = path.join(
        assetDir,
        `${String(screenshotCount + 1).padStart(2, "0")}-${sanitizeFilePart(violation.id)}.png`,
      );

      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count < 1) {
        continue;
      }

      const captured = await captureScreenshot(locator, screenshotPath);
      if (captured) {
        evidence.violations.push({
          id: violation.id,
          target: selector,
          path: path.relative(process.cwd(), screenshotPath),
        });
        screenshotCount += 1;
      }
    }
  }

  const keyboardWarnings = keyboard.stops.filter((stop) => !stop.isBodyFocus && !stop.hasVisibleFocus);
  for (const [index, stop] of keyboardWarnings.entries()) {
    if (screenshotCount >= screenshotLimit) {
      break;
    }

    const locator = page.locator(stop.selector).first();
    const count = await locator.count().catch(() => 0);
    if (count < 1) {
      continue;
    }

    const screenshotPath = path.join(
      assetDir,
      `${String(screenshotCount + 1).padStart(2, "0")}-keyboard-${String(index + 1).padStart(2, "0")}.png`,
    );
    const captured = await captureScreenshot(locator, screenshotPath);
    if (captured) {
      evidence.keyboard.push({
        selector: stop.selector,
        path: path.relative(process.cwd(), screenshotPath),
      });
      screenshotCount += 1;
    }
  }

  return evidence;
}

async function collectActiveElement(page) {
  return page.evaluate(() => {
    function selectorFor(element) {
      if (!element || !(element instanceof Element)) {
        return "document";
      }

      if (element.id) {
        return `#${element.id}`;
      }

      const parts = [];
      let current = element;

      while (current && current instanceof Element && parts.length < 4) {
        let part = current.tagName.toLowerCase();

        if (current.classList.length > 0) {
          part += `.${Array.from(current.classList).slice(0, 2).join(".")}`;
        }

        if (current.parentElement) {
          const siblings = Array.from(current.parentElement.children).filter(
            (node) => node.tagName === current.tagName,
          );
          if (siblings.length > 1) {
            const position = siblings.indexOf(current) + 1;
            part += `:nth-of-type(${position})`;
          }
        }

        parts.unshift(part);
        current = current.parentElement;
      }

      return parts.join(" > ");
    }

    const active = document.activeElement;
    const docEl = document.documentElement;
    const body = document.body;

    if (!active || active === docEl || active === body) {
      return {
        selector: "document",
        tag: active ? active.tagName.toLowerCase() : "none",
        role: null,
        label: "",
        signature: "document",
        hasVisibleFocus: false,
        isBodyFocus: true,
      };
    }

    const style = window.getComputedStyle(active);
    const rect = active.getBoundingClientRect();
    const label =
      active.getAttribute("aria-label") ||
      active.getAttribute("title") ||
      active.getAttribute("name") ||
      active.getAttribute("id") ||
      ("value" in active && typeof active.value === "string" ? active.value : "") ||
      active.textContent ||
      "";

    const outlineWidth = Number.parseFloat(style.outlineWidth || "0");
    const hasVisibleFocus =
      active.matches(":focus-visible") ||
      (style.outlineStyle !== "none" && outlineWidth > 0) ||
      style.boxShadow !== "none";

    return {
      selector: selectorFor(active),
      tag: active.tagName.toLowerCase(),
      role: active.getAttribute("role"),
      label: label.replace(/\s+/g, " ").trim().slice(0, 120),
      signature: `${selectorFor(active)}|${active.getAttribute("role") || ""}`,
      hasVisibleFocus,
      isBodyFocus: false,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  });
}

async function runKeyboardAudit(page, tabLimit) {
  const stops = [];
  const seen = new Set();
  const warnings = new Set();
  let loopDetected = false;

  await page.locator("body").focus();

  for (let step = 1; step <= tabLimit; step += 1) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(75);

    const active = await collectActiveElement(page);
    active.step = step;
    stops.push(active);

    if (active.isBodyFocus) {
      warnings.add(`Tab step ${step} left focus on the document body.`);
    }

    if (!active.isBodyFocus && !active.hasVisibleFocus) {
      warnings.add(`Tab step ${step} reached ${active.selector} without an obvious visible focus indicator.`);
    }

    if (seen.has(active.signature)) {
      loopDetected = true;
      break;
    }

    seen.add(active.signature);
  }

  let reverseNavigationWorked = null;
  if (stops.length > 0) {
    const beforeReverse = stops[stops.length - 1].signature;
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(75);
    const reverseStop = await collectActiveElement(page);
    reverseNavigationWorked = reverseStop.signature !== beforeReverse;

    if (!reverseNavigationWorked) {
      warnings.add("Reverse keyboard navigation did not move focus to a different element.");
    }
  }

  return {
    tabLimit,
    sampledStops: stops.length,
    uniqueStops: seen.size,
    loopDetected,
    reverseNavigationWorked,
    warnings: Array.from(warnings),
    stops,
  };
}

async function collectSemanticSignals(page) {
  return page.evaluate(() => {
    function selectorFor(element) {
      if (element.id) {
        return `#${element.id}`;
      }

      return element.tagName.toLowerCase();
    }

    function textFor(element) {
      return (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
    }

    function hasAssociatedLabel(element) {
      if ("labels" in element && element.labels && element.labels.length > 0) {
        return true;
      }

      const id = element.getAttribute("id");
      return Boolean(id && document.querySelector(`label[for="${CSS.escape(id)}"]`));
    }

    function hasAccessibleName(element) {
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) {
        return true;
      }

      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((node) => textFor(node))
          .join(" ")
          .trim();

        if (text) {
          return true;
        }
      }

      if (element instanceof HTMLImageElement) {
        return element.hasAttribute("alt");
      }

      if (element instanceof HTMLInputElement) {
        if (element.value && element.value.trim()) {
          return true;
        }

        if (element.placeholder && element.placeholder.trim()) {
          return true;
        }
      }

      if (hasAssociatedLabel(element)) {
        return true;
      }

      const title = element.getAttribute("title");
      if (title && title.trim()) {
        return true;
      }

      return Boolean(textFor(element));
    }

    function describe(element) {
      return {
        selector: selectorFor(element),
        text: textFor(element),
      };
    }

    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((heading) => ({
      level: Number.parseInt(heading.tagName.slice(1), 10),
      text: textFor(heading),
    }));

    const headingSkips = [];
    for (let index = 1; index < headings.length; index += 1) {
      const previous = headings[index - 1];
      const current = headings[index];

      if (current.level > previous.level + 1) {
        headingSkips.push({
          from: previous.level,
          to: current.level,
          text: current.text,
        });
      }
    }

    const imagesMissingAlt = Array.from(document.querySelectorAll("img")).filter(
      (image) => !image.hasAttribute("alt"),
    );

    const unlabeledControls = Array.from(
      document.querySelectorAll('input:not([type="hidden"]), select, textarea'),
    ).filter((element) => !hasAccessibleName(element));

    const namelessButtons = Array.from(
      document.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]'),
    ).filter((element) => !hasAccessibleName(element));

    const namelessLinks = Array.from(document.querySelectorAll('a[href], [role="link"]')).filter(
      (element) => !hasAccessibleName(element),
    );

    const positiveTabindex = Array.from(document.querySelectorAll("[tabindex]")).filter(
      (element) => Number.parseInt(element.getAttribute("tabindex") || "0", 10) > 0,
    );

    const landmarks = Array.from(
      document.querySelectorAll(
        "main, nav, header, footer, aside, [role='main'], [role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary'], [role='search'], [role='region']",
      ),
    ).map((element) => selectorFor(element));

    return {
      page: {
        title: document.title,
        lang: document.documentElement.getAttribute("lang"),
      },
      landmarks: {
        count: landmarks.length,
        selectors: landmarks.slice(0, 15),
      },
      headings,
      headingSkips,
      imagesMissingAlt: imagesMissingAlt.slice(0, 10).map(describe),
      unlabeledControls: unlabeledControls.slice(0, 10).map(describe),
      namelessButtons: namelessButtons.slice(0, 10).map(describe),
      namelessLinks: namelessLinks.slice(0, 10).map(describe),
      positiveTabindex: positiveTabindex.slice(0, 10).map(describe),
      counts: {
        imagesMissingAlt: imagesMissingAlt.length,
        unlabeledControls: unlabeledControls.length,
        namelessButtons: namelessButtons.length,
        namelessLinks: namelessLinks.length,
        positiveTabindex: positiveTabindex.length,
      },
    };
  });
}

async function collectFormSignals(page) {
  return page.evaluate(() => {
    function selectorFor(element) {
      if (element.id) {
        return `#${element.id}`;
      }

      const name = element.getAttribute("name");
      if (name) {
        return `${element.tagName.toLowerCase()}[name="${name}"]`;
      }

      const type = element.getAttribute("type");
      if (type) {
        return `${element.tagName.toLowerCase()}[type="${type}"]`;
      }

      return element.tagName.toLowerCase();
    }

    function textFor(element) {
      return (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
    }

    function hasAssociatedLabel(element) {
      if ("labels" in element && element.labels && element.labels.length > 0) {
        return true;
      }

      const id = element.getAttribute("id");
      return Boolean(id && document.querySelector(`label[for="${CSS.escape(id)}"]`));
    }

    function hasAccessibleName(element) {
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) {
        return true;
      }

      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((node) => textFor(node))
          .join(" ")
          .trim();

        if (text) {
          return true;
        }
      }

      if (hasAssociatedLabel(element)) {
        return true;
      }

      return Boolean(textFor(element));
    }

    function describeControl(element, extra = {}) {
      return {
        selector: selectorFor(element),
        type: element.getAttribute("type") || element.tagName.toLowerCase(),
        name: element.getAttribute("name") || "",
        ...extra,
      };
    }

    function closestFieldContainer(element) {
      return (
        element.closest("label, fieldset, .control-field, [role='group'], [role='radiogroup']") ||
        element.parentElement
      );
    }

    function expectedAutocomplete(element) {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        return null;
      }

      if (element.disabled || element.readOnly) {
        return null;
      }

      const type = (element.getAttribute("type") || "").toLowerCase();
      const fingerprint = [
        type,
        element.getAttribute("name") || "",
        element.getAttribute("id") || "",
        element.getAttribute("placeholder") || "",
        textFor(closestFieldContainer(element) || element),
      ]
        .join(" ")
        .toLowerCase();

      if (type === "email" || /\bemail\b/.test(fingerprint)) {
        return "email";
      }
      if (type === "tel" || /\b(phone|mobile|tel)\b/.test(fingerprint)) {
        return "tel";
      }
      if (type === "url" || /\b(url|website|youtube|link)\b/.test(fingerprint)) {
        return "url";
      }
      if (type === "search" || /\bsearch\b/.test(fingerprint)) {
        return "search";
      }
      if (/\b(first.?name|given.?name)\b/.test(fingerprint)) {
        return "given-name";
      }
      if (/\b(last.?name|family.?name|surname)\b/.test(fingerprint)) {
        return "family-name";
      }
      if (/\b(full.?name|your name|contact name)\b/.test(fingerprint)) {
        return "name";
      }
      if (/\b(address line 1|street address|address1)\b/.test(fingerprint)) {
        return "address-line1";
      }
      if (/\b(address line 2|suite|unit|apartment|address2)\b/.test(fingerprint)) {
        return "address-line2";
      }
      if (/\b(city|suburb|town)\b/.test(fingerprint)) {
        return "address-level2";
      }
      if (/\b(state|province|region)\b/.test(fingerprint)) {
        return "address-level1";
      }
      if (/\b(postcode|postal|zip)\b/.test(fingerprint)) {
        return "postal-code";
      }
      if (/\bcountry\b/.test(fingerprint)) {
        return "country";
      }

      return null;
    }

    function findNearbyError(element) {
      const describedBy = (element.getAttribute("aria-describedby") || "")
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean);
      const ariaErrorMessage = element.getAttribute("aria-errormessage");
      const explicitError = ariaErrorMessage ? document.getElementById(ariaErrorMessage) : null;

      const candidates = [...describedBy];
      if (explicitError) {
        candidates.push(explicitError);
      }

      const container = closestFieldContainer(element);
      if (container) {
        if (container.nextElementSibling) {
          candidates.push(container.nextElementSibling);
        }

        for (const node of container.querySelectorAll("[role='alert'], [aria-live], .error, .invalid")) {
          candidates.push(node);
        }
      }

      const seen = new Set();
      for (const candidate of candidates) {
        if (!(candidate instanceof Element) || seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);

        const text = textFor(candidate);
        if (!text) {
          continue;
        }

        if (!/\b(valid|invalid|required|error|must|enter|select|choose|format)\b/i.test(text)) {
          continue;
        }

        const id = candidate.getAttribute("id");
        const isAssociated =
          Boolean(
            id &&
              ((element.getAttribute("aria-describedby") || "")
                .split(/\s+/)
                .includes(id) ||
                element.getAttribute("aria-errormessage") === id),
          ) || describedBy.includes(candidate) || explicitError === candidate;

        return {
          text,
          associated: isAssociated,
        };
      }

      return null;
    }

    const controls = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'));

    const missingAutocomplete = [];
    const placeholderOnlyControls = [];
    const requiredCueOnly = [];
    const invalidWithoutState = [];
    const unassociatedErrorMessages = [];

    for (const control of controls) {
      if (!hasAccessibleName(control) && control.getAttribute("placeholder")) {
        placeholderOnlyControls.push(
          describeControl(control, {
            placeholder: control.getAttribute("placeholder"),
          }),
        );
      }

      const autocomplete = control.getAttribute("autocomplete");
      const expectedToken = expectedAutocomplete(control);
      if (expectedToken && !autocomplete) {
        missingAutocomplete.push(
          describeControl(control, {
            expected: expectedToken,
          }),
        );
      }

      const containerText = textFor(closestFieldContainer(control) || control);
      const requiredHintPresent = /\brequired\b/.test(containerText.toLowerCase()) || containerText.includes("*");
      const hasProgrammaticRequired =
        control.hasAttribute("required") || control.getAttribute("aria-required") === "true";
      if (requiredHintPresent && !hasProgrammaticRequired) {
        requiredCueOnly.push(describeControl(control));
      }

      const error = findNearbyError(control);
      if (error) {
        if (control.getAttribute("aria-invalid") !== "true") {
          invalidWithoutState.push(
            describeControl(control, {
              message: error.text,
            }),
          );
        }

        if (!error.associated) {
          unassociatedErrorMessages.push(
            describeControl(control, {
              message: error.text,
            }),
          );
        }
      }
    }

    return {
      controls: controls.length,
      missingAutocomplete: missingAutocomplete.slice(0, 10),
      placeholderOnlyControls: placeholderOnlyControls.slice(0, 10),
      requiredCueOnly: requiredCueOnly.slice(0, 10),
      invalidWithoutState: invalidWithoutState.slice(0, 10),
      unassociatedErrorMessages: unassociatedErrorMessages.slice(0, 10),
      counts: {
        missingAutocomplete: missingAutocomplete.length,
        placeholderOnlyControls: placeholderOnlyControls.length,
        requiredCueOnly: requiredCueOnly.length,
        invalidWithoutState: invalidWithoutState.length,
        unassociatedErrorMessages: unassociatedErrorMessages.length,
      },
    };
  });
}

async function describeFocusedElement(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || !(active instanceof Element)) {
      return {
        selector: "document",
        text: "",
      };
    }

    const selector = active.id ? `#${active.id}` : active.tagName.toLowerCase();
    const text = (active.innerText || active.textContent || active.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);

    return {
      selector,
      text,
    };
  });
}

async function focusMatches(page, matcher) {
  return page.evaluate((currentMatcher) => {
    const active = document.activeElement;
    if (!active || !(active instanceof Element)) {
      return false;
    }

    if (currentMatcher.selector) {
      try {
        return active.matches(currentMatcher.selector);
      } catch {
        return false;
      }
    }

    if (currentMatcher.text) {
      const text = (active.innerText || active.textContent || active.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim();
      return text.toLowerCase().includes(String(currentMatcher.text).toLowerCase());
    }

    if (currentMatcher.href) {
      return active.getAttribute("href") === currentMatcher.href;
    }

    return false;
  }, matcher);
}

async function runJourney(page, journey) {
  if (!journey || !Array.isArray(journey.steps) || journey.steps.length === 0) {
    return null;
  }

  const results = [];
  let failures = 0;
  const snapshots = new Map();

  async function readState(step) {
    const source = step.source || "text";

    if (source === "url") {
      return page.url();
    }

    if (source === "focus") {
      return JSON.stringify(await describeFocusedElement(page));
    }

    if (!step.selector) {
      throw new Error(`${source} state reads require a selector.`);
    }

    const locator = page.locator(step.selector).first();
    if (source === "text") {
      return (await locator.innerText({ timeout: step.timeout ?? 5000 })).trim();
    }
    if (source === "value") {
      return await locator.inputValue({ timeout: step.timeout ?? 5000 });
    }
    if (source === "attribute") {
      if (!step.attribute) {
        throw new Error("attribute state reads require an attribute name.");
      }
      return await locator.getAttribute(step.attribute);
    }

    throw new Error(`Unsupported state source: ${source}`);
  }

  for (let index = 0; index < journey.steps.length; index += 1) {
    const step = journey.steps[index];
    const stepNumber = index + 1;
    const result = {
      step: stepNumber,
      action: step.action,
      label: step.label || null,
      success: true,
    };

    try {
      switch (step.action) {
        case "tab": {
          const count = Number.isFinite(step.count) ? step.count : 1;
          for (let cursor = 0; cursor < count; cursor += 1) {
            await page.keyboard.press(step.shift ? "Shift+Tab" : "Tab");
            await page.waitForTimeout(step.wait ?? 75);
          }
          result.focus = await describeFocusedElement(page);
          break;
        }
        case "tab_until": {
          const maxTabs = Number.isFinite(step.maxTabs) ? step.maxTabs : 20;
          let matched = false;
          for (let cursor = 0; cursor < maxTabs; cursor += 1) {
            await page.keyboard.press(step.shift ? "Shift+Tab" : "Tab");
            await page.waitForTimeout(step.wait ?? 75);
            if (await focusMatches(page, step)) {
              matched = true;
              break;
            }
          }
          result.focus = await describeFocusedElement(page);
          if (!matched) {
            throw new Error(`Focus did not reach the requested target within ${maxTabs} tab step(s).`);
          }
          break;
        }
        case "press": {
          if (!step.key) {
            throw new Error("press action requires a key.");
          }
          await page.keyboard.press(step.key);
          await page.waitForTimeout(step.wait ?? 150);
          result.focus = await describeFocusedElement(page);
          break;
        }
        case "click": {
          if (!step.selector) {
            throw new Error("click action requires a selector.");
          }
          await page.locator(step.selector).first().click({ timeout: step.timeout ?? 5000 });
          await page.waitForTimeout(step.wait ?? 150);
          result.selector = step.selector;
          break;
        }
        case "fill": {
          if (!step.selector || typeof step.text !== "string") {
            throw new Error("fill action requires selector and text.");
          }
          await page.locator(step.selector).first().fill(step.text, { timeout: step.timeout ?? 5000 });
          await page.waitForTimeout(step.wait ?? 75);
          result.selector = step.selector;
          break;
        }
        case "type": {
          if (typeof step.text !== "string") {
            throw new Error("type action requires text.");
          }
          await page.keyboard.type(step.text, { delay: step.delay ?? 20 });
          await page.waitForTimeout(step.wait ?? 75);
          result.focus = await describeFocusedElement(page);
          break;
        }
        case "remember": {
          if (!step.name) {
            throw new Error("remember action requires a name.");
          }
          const value = await readState(step);
          snapshots.set(step.name, {
            source: step.source || "text",
            selector: step.selector || null,
            attribute: step.attribute || null,
            value,
          });
          result.name = step.name;
          break;
        }
        case "wait": {
          await page.waitForTimeout(step.ms ?? 250);
          break;
        }
        case "expect_url_includes": {
          const url = page.url();
          if (!url.includes(step.value)) {
            throw new Error(`URL "${url}" does not include "${step.value}".`);
          }
          result.url = url;
          break;
        }
        case "expect_visible": {
          if (!step.selector) {
            throw new Error("expect_visible action requires a selector.");
          }
          await page.locator(step.selector).first().waitFor({ state: "visible", timeout: step.timeout ?? 5000 });
          result.selector = step.selector;
          break;
        }
        case "expect_focused": {
          if (!(await focusMatches(page, step))) {
            throw new Error("Focused element does not match the expected target.");
          }
          result.focus = await describeFocusedElement(page);
          break;
        }
        case "expect_text": {
          if (!step.selector || typeof step.value !== "string") {
            throw new Error("expect_text action requires selector and value.");
          }
          const text = await page.locator(step.selector).first().innerText({ timeout: step.timeout ?? 5000 });
          if (!text.toLowerCase().includes(step.value.toLowerCase())) {
            throw new Error(`Text for ${step.selector} did not include "${step.value}".`);
          }
          result.selector = step.selector;
          break;
        }
        case "expect_changed": {
          if (!step.name) {
            throw new Error("expect_changed action requires a snapshot name.");
          }
          const snapshot = snapshots.get(step.name);
          if (!snapshot) {
            throw new Error(`No snapshot stored as "${step.name}".`);
          }

          const currentValue = await readState({
            selector: step.selector || snapshot.selector,
            source: step.source || snapshot.source,
            attribute: step.attribute || snapshot.attribute,
            timeout: step.timeout,
          });

          if (currentValue === snapshot.value) {
            throw new Error(`State "${step.name}" did not change.`);
          }

          result.name = step.name;
          break;
        }
        case "expect_attribute": {
          if (!step.selector || !step.attribute) {
            throw new Error("expect_attribute action requires selector and attribute.");
          }
          const value = await page.locator(step.selector).first().getAttribute(step.attribute);
          if (typeof step.value === "string" && value !== step.value) {
            throw new Error(`Attribute ${step.attribute} for ${step.selector} was "${value}" not "${step.value}".`);
          }
          if (typeof step.includes === "string" && !(value || "").includes(step.includes)) {
            throw new Error(`Attribute ${step.attribute} for ${step.selector} did not include "${step.includes}".`);
          }
          result.selector = step.selector;
          break;
        }
        case "expect_value": {
          if (!step.selector) {
            throw new Error("expect_value action requires a selector.");
          }
          const value = await page.locator(step.selector).first().inputValue({ timeout: step.timeout ?? 5000 });
          if (typeof step.value === "string" && value !== step.value) {
            throw new Error(`Value for ${step.selector} was "${value}" not "${step.value}".`);
          }
          if (typeof step.includes === "string" && !value.includes(step.includes)) {
            throw new Error(`Value for ${step.selector} did not include "${step.includes}".`);
          }
          result.selector = step.selector;
          break;
        }
        default:
          throw new Error(`Unsupported journey action: ${step.action}`);
      }
    } catch (error) {
      result.success = false;
      result.error = error instanceof Error ? error.message : String(error);
      failures += 1;
    }

    results.push(result);
    if (!result.success && step.stopOnFailure !== false) {
      break;
    }
  }

  return {
    name: journey.name || "journey",
    success: failures === 0,
    totalSteps: results.length,
    failedSteps: failures,
    results,
  };
}

async function collectReflowChecks(page, widths) {
  const originalViewport = page.viewportSize() || { width: 1440, height: 960 };
  const checks = [];

  for (const width of widths) {
    await page.setViewportSize({ width, height: originalViewport.height });
    await page.waitForTimeout(300);

    const check = await page.evaluate(() => {
      function selectorFor(element) {
        if (element.id) {
          return `#${element.id}`;
        }

        return element.tagName.toLowerCase();
      }

      function describe(element) {
        return {
          selector: selectorFor(element),
          text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        };
      }

      const overflowingElements = Array.from(document.querySelectorAll("body *"))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.right > window.innerWidth + 1;
        })
        .slice(0, 10)
        .map(describe);

      const clippedTextElements = Array.from(document.querySelectorAll("body *"))
        .filter((element) => {
          const style = window.getComputedStyle(element);
          const text = (element.textContent || "").trim();
          return (
            text.length > 20 &&
            element.scrollWidth > element.clientWidth + 1 &&
            ["hidden", "clip"].includes(style.overflowX)
          );
        })
        .slice(0, 10)
        .map(describe);

      const horizontalScrollDetected = document.documentElement.scrollWidth > window.innerWidth + 1;
      const warnings = [];
      if (horizontalScrollDetected) {
        warnings.push("Page requires horizontal scrolling at this width.");
      }
      if (overflowingElements.length > 0) {
        warnings.push(`Detected ${overflowingElements.length} overflowing element sample(s).`);
      }
      if (clippedTextElements.length > 0) {
        warnings.push(`Detected ${clippedTextElements.length} clipped-text sample(s).`);
      }

      return {
        width: window.innerWidth,
        horizontalScrollDetected,
        overflowingElements,
        clippedTextElements,
        warningCount: warnings.length,
        warnings,
      };
    });

    checks.push(check);
  }

  await page.setViewportSize(originalViewport);
  await page.waitForTimeout(100);

  return checks;
}

function buildSummary(axeViolations, keyboard, semantics, form, reflowChecks = []) {
  const impactCounts = summarizeImpactCounts(axeViolations);
  const simplifiedViolations = simplifyAxeResults(axeViolations);
  const contrastViolations = axeViolations.filter((item) => item.id === "color-contrast");
  const screenReaderWarnings = [];
  const formWarnings = [];

  if (!semantics.page.lang) {
    screenReaderWarnings.push("The page is missing a root html[lang] attribute.");
  }

  if (semantics.landmarks.count === 0) {
    screenReaderWarnings.push("No page landmarks were detected.");
  }

  if (semantics.headingSkips.length > 0) {
    screenReaderWarnings.push(`Detected ${semantics.headingSkips.length} heading level skip(s).`);
  }

  if (semantics.counts.unlabeledControls > 0) {
    screenReaderWarnings.push(`Detected ${semantics.counts.unlabeledControls} unlabeled form control(s).`);
  }

  if (semantics.counts.namelessButtons > 0) {
    screenReaderWarnings.push(`Detected ${semantics.counts.namelessButtons} button(s) without an accessible name.`);
  }

  if (semantics.counts.namelessLinks > 0) {
    screenReaderWarnings.push(`Detected ${semantics.counts.namelessLinks} link(s) without an accessible name.`);
  }

  if (semantics.counts.imagesMissingAlt > 0) {
    screenReaderWarnings.push(`Detected ${semantics.counts.imagesMissingAlt} image(s) missing alt text.`);
  }

  if (semantics.counts.positiveTabindex > 0) {
    keyboard.warnings.push(
      `Detected ${semantics.counts.positiveTabindex} element(s) using positive tabindex, which can create confusing tab order.`,
    );
  }

  if (form.counts.missingAutocomplete > 0) {
    formWarnings.push(
      `Detected ${form.counts.missingAutocomplete} field(s) that look autofill-eligible but do not declare autocomplete.`,
    );
  }

  if (form.counts.placeholderOnlyControls > 0) {
    formWarnings.push(`Detected ${form.counts.placeholderOnlyControls} field(s) relying on placeholder text instead of labels.`);
  }

  if (form.counts.requiredCueOnly > 0) {
    formWarnings.push(`Detected ${form.counts.requiredCueOnly} field(s) with a visible required cue but no programmatic required state.`);
  }

  if (form.counts.invalidWithoutState > 0) {
    formWarnings.push(`Detected ${form.counts.invalidWithoutState} invalid field(s) without aria-invalid=\"true\".`);
  }

  if (form.counts.unassociatedErrorMessages > 0) {
    formWarnings.push(`Detected ${form.counts.unassociatedErrorMessages} validation message(s) not tied to a field via aria-describedby or aria-errormessage.`);
  }

  return {
    axeViolationCount: axeViolations.length,
    axeImpactCounts: impactCounts,
    severityBuckets: buildSeverityBuckets(simplifiedViolations),
    wcagSummary: buildWcagSummary(simplifiedViolations),
    contrastViolationCount: contrastViolations.length,
    formWarningCount: formWarnings.length,
    journeyFailureCount: 0,
    keyboardWarningCount: keyboard.warnings.length,
    reflowWarningCount: reflowChecks.filter((check) => check.warningCount > 0).length,
    formWarnings,
    screenReaderWarningCount: screenReaderWarnings.length,
    screenReaderWarnings,
  };
}

export function renderMarkdown(report) {
  const lines = [];
  const { metadata, summary, keyboard, semantics, form, axe } = report;

  lines.push(`# Accessibility Audit: ${metadata.title || metadata.url}`);
  lines.push("");
  lines.push(`- URL: ${metadata.url}`);
  lines.push(`- Title: ${metadata.title || "(no title)"}`);
  lines.push(`- Tested at: ${metadata.testedAt}`);
  lines.push(`- Axe violations: ${summary.axeViolationCount}`);
  lines.push(`- Contrast violations: ${summary.contrastViolationCount}`);
  lines.push(`- Keyboard warnings: ${summary.keyboardWarningCount}`);
  lines.push(`- Reflow warnings: ${summary.reflowWarningCount}`);
  lines.push(`- Form warnings: ${summary.formWarningCount}`);
  lines.push(`- Journey failures: ${summary.journeyFailureCount}`);
  lines.push(`- Screen-reader warnings: ${summary.screenReaderWarningCount}`);
  lines.push("");
  lines.push("## Axe Summary");
  lines.push("");
  lines.push(
    `Critical: ${summary.axeImpactCounts.critical}, Serious: ${summary.axeImpactCounts.serious}, Moderate: ${summary.axeImpactCounts.moderate}, Minor: ${summary.axeImpactCounts.minor}, Unknown: ${summary.axeImpactCounts.unknown}`,
  );
  lines.push("");

  lines.push("## Severity Buckets");
  lines.push("");
  for (const bucket of ["critical", "serious", "moderate", "minor", "unknown"]) {
    const items = summary.severityBuckets[bucket];
    if (items.length === 0) {
      continue;
    }

    lines.push(`### ${bucket}`);
    lines.push("");
    for (const item of items) {
      const wcagText = item.wcagTags.length > 0 ? ` | ${item.wcagTags.join(", ")}` : "";
      lines.push(`- ${item.id}: ${item.affectedNodes} node(s)${wcagText}`);
    }
    lines.push("");
  }

  lines.push("## WCAG Mapping");
  lines.push("");
  if (summary.wcagSummary.length === 0) {
    lines.push("No WCAG tags were attached to the detected violations.");
    lines.push("");
  } else {
    for (const item of summary.wcagSummary) {
      lines.push(`- ${item.tag}: ${item.count}`);
    }
    lines.push("");
  }

  if (axe.violations.length === 0) {
    lines.push("No axe violations were detected on the sampled page state.");
    lines.push("");
  } else {
    for (const violation of axe.violations.slice(0, 10)) {
      lines.push(`### ${violation.id} (${violation.impact})`);
      lines.push("");
      lines.push(`${violation.help} Affected nodes: ${violation.affectedNodes}`);
      lines.push("");
      for (const node of violation.nodes.slice(0, 3)) {
        lines.push(`- ${node.target.join(", ")} :: ${node.failureSummary || node.html}`);
      }
      lines.push("");
    }
  }

  lines.push("## Keyboard Navigation");
  lines.push("");
  lines.push(`- Sampled tab stops: ${keyboard.sampledStops}`);
  lines.push(`- Unique tab stops: ${keyboard.uniqueStops}`);
  lines.push(`- Focus loop detected: ${keyboard.loopDetected ? "yes" : "no"}`);
  lines.push(
    `- Reverse Shift+Tab moved focus: ${
      keyboard.reverseNavigationWorked === null ? "not tested" : keyboard.reverseNavigationWorked ? "yes" : "no"
    }`,
  );
  lines.push("");

  if (keyboard.warnings.length === 0) {
    lines.push("No keyboard warnings were generated by the sampled traversal.");
    lines.push("");
  } else {
    for (const warning of keyboard.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  if (report.journey) {
    lines.push("## Keyboard Journey");
    lines.push("");
    lines.push(`- Journey: ${report.journey.name}`);
    lines.push(`- Success: ${report.journey.success ? "yes" : "no"}`);
    lines.push(`- Failed steps: ${report.journey.failedSteps}`);
    lines.push("");
    for (const item of report.journey.results) {
      const status = item.success ? "PASS" : "FAIL";
      const suffix = item.label ? ` (${item.label})` : "";
      lines.push(`- Step ${item.step} ${status}: ${item.action}${suffix}`);
      if (item.error) {
        lines.push(`  ${item.error}`);
      }
    }
    lines.push("");
  }

  lines.push("## Reflow Checks");
  lines.push("");
  if (!report.reflow || report.reflow.length === 0) {
    lines.push("No reflow checks were requested for this audit.");
    lines.push("");
  } else {
    for (const check of report.reflow) {
      lines.push(`### width ${check.width}px`);
      lines.push("");
      lines.push(`- Horizontal scroll: ${check.horizontalScrollDetected ? "yes" : "no"}`);
      lines.push(`- Overflow sample count: ${check.overflowingElements.length}`);
      lines.push(`- Clipped text sample count: ${check.clippedTextElements.length}`);
      for (const warning of check.warnings) {
        lines.push(`- ${warning}`);
      }
      lines.push("");
    }
  }

  lines.push("## Screen Reader Proxies");
  lines.push("");
  lines.push(`- html[lang]: ${semantics.page.lang || "(missing)"}`);
  lines.push(`- Landmarks found: ${semantics.landmarks.count}`);
  lines.push(`- Heading skips: ${semantics.headingSkips.length}`);
  lines.push(`- Images missing alt: ${semantics.counts.imagesMissingAlt}`);
  lines.push(`- Unlabeled controls: ${semantics.counts.unlabeledControls}`);
  lines.push(`- Nameless buttons: ${semantics.counts.namelessButtons}`);
  lines.push(`- Nameless links: ${semantics.counts.namelessLinks}`);
  lines.push("");

  if (summary.screenReaderWarnings.length === 0) {
    lines.push("No screen-reader proxy warnings were generated beyond axe findings.");
    lines.push("");
  } else {
    for (const warning of summary.screenReaderWarnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  lines.push("## Form Checks");
  lines.push("");
  lines.push(`- Controls sampled: ${form.controls}`);
  lines.push(`- Missing autocomplete: ${form.counts.missingAutocomplete}`);
  lines.push(`- Placeholder-only labels: ${form.counts.placeholderOnlyControls}`);
  lines.push(`- Required cue without required state: ${form.counts.requiredCueOnly}`);
  lines.push(`- Invalid fields missing aria-invalid: ${form.counts.invalidWithoutState}`);
  lines.push(`- Unassociated error messages: ${form.counts.unassociatedErrorMessages}`);
  lines.push("");

  if (summary.formWarnings.length === 0) {
    lines.push("No form-specific warnings were generated.");
    lines.push("");
  } else {
    for (const warning of summary.formWarnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  const formExamples = [
    ...form.missingAutocomplete.map((item) => `Missing autocomplete on ${item.selector} (expected ${item.expected}).`),
    ...form.placeholderOnlyControls.map((item) => `Placeholder-only label candidate: ${item.selector}.`),
    ...form.requiredCueOnly.map((item) => `Required cue without required state: ${item.selector}.`),
    ...form.invalidWithoutState.map((item) => `Invalid field without aria-invalid: ${item.selector}.`),
    ...form.unassociatedErrorMessages.map(
      (item) => `Validation message not associated to ${item.selector}: ${trimText(item.message, 120)}`,
    ),
  ].slice(0, 10);

  for (const example of formExamples) {
    lines.push(`- ${example}`);
  }
  if (formExamples.length > 0) {
    lines.push("");
  }

  if (report.evidence) {
    lines.push("## Evidence");
    lines.push("");
    if (report.evidence.page) {
      lines.push(`- Full page screenshot: ${report.evidence.page}`);
    }
    for (const item of report.evidence.violations) {
      lines.push(`- ${item.id}: ${item.path}`);
    }
    for (const item of report.evidence.keyboard) {
      lines.push(`- Keyboard focus evidence for ${item.selector}: ${item.path}`);
    }
    lines.push("");
  }

  lines.push("## Limits");
  lines.push("");
  lines.push("- This is an automated audit of one page state, not a full manual accessibility review.");
  lines.push("- Confirm dynamic widgets, announcements, and real assistive-technology behavior manually.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

export function renderAggregateMarkdown(aggregateReport) {
  const lines = [];
  const { metadata, summary, pages } = aggregateReport;

  lines.push(`# Accessibility Crawl: ${metadata.seedUrl}`);
  lines.push("");
  lines.push(`- Seed URL: ${metadata.seedUrl}`);
  lines.push(`- Pages audited: ${summary.pagesAudited}`);
  lines.push(`- Pages requested: ${metadata.maxPages}`);
  lines.push(`- Tested at: ${metadata.testedAt}`);
  lines.push(`- Total axe violations: ${summary.totalAxeViolations}`);
  lines.push(`- Pages with keyboard warnings: ${summary.pagesWithKeyboardWarnings}`);
  lines.push(`- Pages with reflow warnings: ${summary.pagesWithReflowWarnings}`);
  lines.push(`- Pages with form warnings: ${summary.pagesWithFormWarnings}`);
  lines.push(`- Pages with screen-reader warnings: ${summary.pagesWithScreenReaderWarnings}`);
  lines.push("");
  lines.push("## Severity Totals");
  lines.push("");
  lines.push(
    `Critical: ${summary.severityCounts.critical}, Serious: ${summary.severityCounts.serious}, Moderate: ${summary.severityCounts.moderate}, Minor: ${summary.severityCounts.minor}, Unknown: ${summary.severityCounts.unknown}`,
  );
  lines.push("");
  lines.push("## WCAG Mapping");
  lines.push("");

  if (summary.wcagSummary.length === 0) {
    lines.push("No WCAG tags were attached to the detected violations.");
    lines.push("");
  } else {
    for (const item of summary.wcagSummary) {
      lines.push(`- ${item.tag}: ${item.count}`);
    }
    lines.push("");
  }

  lines.push("## Top Violation Rules");
  lines.push("");

  if (summary.topViolationRules.length === 0) {
    lines.push("No axe violations were detected across the sampled pages.");
    lines.push("");
  } else {
    for (const rule of summary.topViolationRules) {
      lines.push(`- ${rule.id}: ${rule.count}`);
    }
    lines.push("");
  }

  lines.push("## Per-Page Summary");
  lines.push("");
  for (const page of pages) {
    lines.push(`### ${page.metadata.title || page.metadata.url}`);
    lines.push("");
    lines.push(`- URL: ${page.metadata.url}`);
    lines.push(`- Axe violations: ${page.summary.axeViolationCount}`);
    lines.push(`- Keyboard warnings: ${page.summary.keyboardWarningCount}`);
    lines.push(`- Form warnings: ${page.summary.formWarningCount}`);
    lines.push(`- Screen-reader warnings: ${page.summary.screenReaderWarningCount}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export async function createBrowserContext() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: "light",
  });

  return {
    browser,
    context,
  };
}

export async function closeBrowserContext(resources) {
  const { context, browser } = resources;
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

export async function auditPageInContext(context, options) {
  const {
    url,
    tabLimit = 20,
    timeout = 45000,
    wait = 1000,
    journey = null,
    reflowCheck = false,
    reflowWidths = [320, 768],
    screenshots = false,
    assetDir = null,
    screenshotLimit = 10,
  } = options;

  const testedAt = new Date();
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout,
    });

    await page.waitForLoadState("networkidle", {
      timeout: Math.min(timeout, 15000),
    }).catch(() => {});

    if (wait > 0) {
      await page.waitForTimeout(wait);
    }

    const title = await page.title();
    const axeRaw = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
      .analyze();

    const keyboard = await runKeyboardAudit(page, tabLimit);
    const semantics = await collectSemanticSignals(page);
    const reflow = reflowCheck ? await collectReflowChecks(page, reflowWidths) : [];
    const journeyReport = journey ? await runJourney(page, journey) : null;
    const form = await collectFormSignals(page);
    const summary = buildSummary(axeRaw.violations, keyboard, semantics, form, reflow);
    const report = {
      metadata: {
        url: page.url(),
        title,
        testedAt: testedAt.toISOString(),
        viewport: { width: 1440, height: 960 },
      },
      summary,
      axe: {
        passes: axeRaw.passes.length,
        violations: simplifyAxeResults(axeRaw.violations),
        incomplete: simplifyAxeResults(axeRaw.incomplete),
        inapplicable: axeRaw.inapplicable.length,
      },
      keyboard,
      reflow,
      semantics,
      form,
    };

    if (journeyReport) {
      report.journey = journeyReport;
      report.summary.journeyFailureCount = report.journey.failedSteps;
    }

    if (screenshots && assetDir) {
      report.evidence = await captureEvidence(page, axeRaw.violations, keyboard, assetDir, screenshotLimit);
    }

    return report;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function writeReportFiles(outBase, report, renderFn = renderMarkdown) {
  const markdown = renderFn(report);
  await fs.mkdir(path.dirname(outBase), { recursive: true });
  await fs.writeFile(`${outBase}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(`${outBase}.md`, markdown, "utf8");
}
