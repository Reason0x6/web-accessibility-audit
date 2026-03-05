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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeCsv(value) {
  const normalized = String(value ?? "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (/[",]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function toCsv(rows) {
  return `${rows.map((row) => row.map((cell) => escapeCsv(cell)).join(",")).join("\n")}\n`;
}

function isAggregateReport(report) {
  return Array.isArray(report?.pages);
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

async function collectNonTextContrastSignals(page) {
  return page.evaluate(() => {
    const parser = document.createElement("span");
    parser.style.display = "none";
    document.body.appendChild(parser);

    function selectorFor(element) {
      if (element.id) {
        return `#${element.id}`;
      }

      const name = element.getAttribute("name");
      if (name) {
        return `${element.tagName.toLowerCase()}[name="${name}"]`;
      }

      return element.tagName.toLowerCase();
    }

    function textFor(element) {
      return (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
    }

    function parseColor(value) {
      if (!value || value === "transparent") {
        return null;
      }

      parser.style.color = "";
      parser.style.color = value;
      const normalized = getComputedStyle(parser).color;
      const match = normalized.match(/rgba?\(([^)]+)\)/i);
      if (!match) {
        return null;
      }

      const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
      const [r, g, b, a = 1] = parts;
      return { r, g, b, a };
    }

    function blend(foreground, background) {
      const alpha = foreground.a ?? 1;
      return {
        r: foreground.r * alpha + background.r * (1 - alpha),
        g: foreground.g * alpha + background.g * (1 - alpha),
        b: foreground.b * alpha + background.b * (1 - alpha),
        a: 1,
      };
    }

    function luminance(color) {
      const convert = (value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      };

      const red = convert(color.r);
      const green = convert(color.g);
      const blue = convert(color.b);
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    }

    function contrastRatio(left, right) {
      const first = luminance(left);
      const second = luminance(right);
      const [lighter, darker] = first > second ? [first, second] : [second, first];
      return (lighter + 0.05) / (darker + 0.05);
    }

    function effectiveBackground(element, includeSelf) {
      const stack = [];
      let current = includeSelf ? element : element.parentElement;

      while (current && current instanceof Element) {
        const background = parseColor(getComputedStyle(current).backgroundColor);
        if (background && background.a > 0) {
          stack.push(background);
        }
        current = current.parentElement;
      }

      let color = { r: 255, g: 255, b: 255, a: 1 };
      for (const background of stack.reverse()) {
        color = blend(background, color);
      }

      return color;
    }

    function describeElement(element, extra = {}) {
      return {
        selector: selectorFor(element),
        text: textFor(element),
        ...extra,
      };
    }

    const candidates = Array.from(
      document.querySelectorAll(
        'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"]',
      ),
    );

    const lowContrastBoundaries = [];
    const lowContrastIcons = [];

    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) {
        continue;
      }

      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number.parseFloat(style.opacity || "1") === 0) {
        continue;
      }

      const surroundingBackground = effectiveBackground(element, false);
      const componentBackground = effectiveBackground(element, true);
      const foregroundColor = parseColor(style.color);
      const borderColor = parseColor(style.borderColor);
      const borderWidth = Math.max(
        Number.parseFloat(style.borderTopWidth || "0"),
        Number.parseFloat(style.borderRightWidth || "0"),
        Number.parseFloat(style.borderBottomWidth || "0"),
        Number.parseFloat(style.borderLeftWidth || "0"),
      );

      const backgroundContrast = contrastRatio(componentBackground, surroundingBackground);
      const borderContrast =
        borderColor && borderWidth > 0 && !["none", "hidden"].includes(style.borderStyle)
          ? contrastRatio(blend(borderColor, surroundingBackground), surroundingBackground)
          : 1;
      const boundaryContrast = Math.max(backgroundContrast, borderContrast);

      if (boundaryContrast < 3) {
        lowContrastBoundaries.push(
          describeElement(element, {
            contrastRatio: Number.parseFloat(boundaryContrast.toFixed(2)),
          }),
        );
      }

      const isIconLike = Boolean(element.querySelector("svg")) || textFor(element).length <= 2;
      if (isIconLike && foregroundColor) {
        const iconContrast = contrastRatio(blend(foregroundColor, componentBackground), componentBackground);
        if (iconContrast < 3) {
          lowContrastIcons.push(
            describeElement(element, {
              contrastRatio: Number.parseFloat(iconContrast.toFixed(2)),
            }),
          );
        }
      }
    }

    parser.remove();

    return {
      lowContrastBoundaries: lowContrastBoundaries.slice(0, 10),
      lowContrastIcons: lowContrastIcons.slice(0, 10),
      counts: {
        lowContrastBoundaries: lowContrastBoundaries.length,
        lowContrastIcons: lowContrastIcons.length,
      },
    };
  });
}

async function collectMobileChecks(page, viewports) {
  const originalViewport = page.viewportSize() || { width: 1440, height: 960 };
  const checks = [];

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(300);

    const check = await page.evaluate((currentViewport) => {
      function selectorFor(element) {
        if (element.id) {
          return `#${element.id}`;
        }

        const name = element.getAttribute("name");
        if (name) {
          return `${element.tagName.toLowerCase()}[name="${name}"]`;
        }

        return element.tagName.toLowerCase();
      }

      function textFor(element) {
        return (element.innerText || element.textContent || element.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);
      }

      const candidates = Array.from(
        document.querySelectorAll(
          'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"]',
        ),
      );

      const touchTargetFailures = candidates
        .filter((element) => {
          const style = window.getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number.parseFloat(style.opacity || "1") === 0 ||
            element.hasAttribute("disabled")
          ) {
            return false;
          }

          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
        })
        .slice(0, 10)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            selector: selectorFor(element),
            text: textFor(element),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        });

      const horizontalScrollDetected = document.documentElement.scrollWidth > window.innerWidth + 1;
      const warnings = [];
      if (horizontalScrollDetected) {
        warnings.push("Page requires horizontal scrolling in this mobile viewport.");
      }
      if (touchTargetFailures.length > 0) {
        warnings.push(`Detected ${touchTargetFailures.length} touch target sample(s) smaller than 44 by 44 CSS pixels.`);
      }

      return {
        label: currentViewport.label,
        width: window.innerWidth,
        height: window.innerHeight,
        horizontalScrollDetected,
        touchTargetFailures,
        warningCount: warnings.length,
        warnings,
      };
    }, viewport);

    checks.push(check);
  }

  await page.setViewportSize(originalViewport);
  await page.waitForTimeout(100);

  return checks;
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

function applyAxeSeverityOverrides(violations, overrides = {}) {
  return violations.map((violation) => ({
    ...violation,
    impact: overrides[violation.id] || violation.impact || "unknown",
  }));
}

function matchesRequirementScope(url, item = {}) {
  const includes = item.urlIncludes;
  const matches = item.urlMatches;

  if (includes !== undefined) {
    const values = Array.isArray(includes) ? includes : [includes];
    if (!values.some((value) => url.includes(String(value)))) {
      return false;
    }
  }

  if (matches !== undefined) {
    const patterns = Array.isArray(matches) ? matches : [matches];
    if (!patterns.some((pattern) => new RegExp(String(pattern)).test(url))) {
      return false;
    }
  }

  return true;
}

async function evaluateRequirementRule(page, rule) {
  const result = {
    id: rule.id || rule.type || "custom-rule",
    label: rule.label || null,
    type: rule.type,
    severity: rule.severity || "serious",
    selector: rule.selector || null,
    success: true,
    message: rule.message || "",
  };
  const timeout = rule.timeout ?? 5000;

  try {
    let locator = null;
    let count = 0;
    if (rule.selector) {
      locator = page.locator(rule.selector);
      count = await locator.count();
    }

    switch (rule.type) {
      case "selector_exists":
        if (!locator) {
          throw new Error("selector_exists requires a selector.");
        }
        if (count < 1) {
          throw new Error(rule.message || `No element matched ${rule.selector}.`);
        }
        result.observed = `${count} match(es)`;
        break;
      case "selector_absent":
        if (!locator) {
          throw new Error("selector_absent requires a selector.");
        }
        if (count > 0) {
          throw new Error(rule.message || `${rule.selector} matched ${count} element(s).`);
        }
        result.observed = "0 matches";
        break;
      case "selector_visible":
        if (!locator) {
          throw new Error("selector_visible requires a selector.");
        }
        if (count < 1 || !(await locator.first().isVisible({ timeout }))) {
          throw new Error(rule.message || `${rule.selector} was not visible.`);
        }
        result.observed = "visible";
        break;
      case "text_includes": {
        if (!locator || typeof rule.value !== "string") {
          throw new Error("text_includes requires selector and value.");
        }
        const text = await locator.first().innerText({ timeout });
        result.observed = trimText(text, 180);
        if (!text.toLowerCase().includes(rule.value.toLowerCase())) {
          throw new Error(rule.message || `Text for ${rule.selector} did not include "${rule.value}".`);
        }
        break;
      }
      case "text_excludes": {
        const text = locator
          ? await locator.first().innerText({ timeout })
          : await page.locator("body").innerText({ timeout });
        result.observed = trimText(text, 180);
        if (typeof rule.value !== "string") {
          throw new Error("text_excludes requires a value.");
        }
        if (text.toLowerCase().includes(rule.value.toLowerCase())) {
          throw new Error(rule.message || `Text unexpectedly included "${rule.value}".`);
        }
        break;
      }
      case "attribute_equals": {
        if (!locator || !rule.attribute) {
          throw new Error("attribute_equals requires selector and attribute.");
        }
        const value = await locator.first().getAttribute(rule.attribute, { timeout });
        result.observed = value;
        if (value !== rule.value) {
          throw new Error(rule.message || `Attribute ${rule.attribute} for ${rule.selector} was "${value}".`);
        }
        break;
      }
      case "attribute_includes": {
        if (!locator || !rule.attribute || typeof rule.value !== "string") {
          throw new Error("attribute_includes requires selector, attribute, and value.");
        }
        const value = await locator.first().getAttribute(rule.attribute, { timeout });
        result.observed = value;
        if (!(value || "").includes(rule.value)) {
          throw new Error(rule.message || `Attribute ${rule.attribute} for ${rule.selector} did not include "${rule.value}".`);
        }
        break;
      }
      case "count_at_least":
        if (!locator || !Number.isFinite(rule.min)) {
          throw new Error("count_at_least requires selector and min.");
        }
        result.observed = `${count} match(es)`;
        if (count < rule.min) {
          throw new Error(rule.message || `${rule.selector} matched ${count} element(s), below ${rule.min}.`);
        }
        break;
      case "count_at_most":
        if (!locator || !Number.isFinite(rule.max)) {
          throw new Error("count_at_most requires selector and max.");
        }
        result.observed = `${count} match(es)`;
        if (count > rule.max) {
          throw new Error(rule.message || `${rule.selector} matched ${count} element(s), above ${rule.max}.`);
        }
        break;
      case "url_includes": {
        if (typeof rule.value !== "string") {
          throw new Error("url_includes requires a value.");
        }
        const url = page.url();
        result.observed = url;
        if (!url.includes(rule.value)) {
          throw new Error(rule.message || `URL "${url}" did not include "${rule.value}".`);
        }
        break;
      }
      default:
        throw new Error(`Unsupported custom requirement type: ${rule.type}`);
    }
  } catch (error) {
    result.success = false;
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

async function openAuditPage(page, url, timeout, wait) {
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
}

async function runRequirementsAssessment(context, page, options, requirements) {
  if (!requirements) {
    return null;
  }

  const pageUrl = page.url();
  const ruleResults = [];
  for (const rule of requirements.rules.filter((item) => matchesRequirementScope(pageUrl, item))) {
    ruleResults.push(await evaluateRequirementRule(page, rule));
  }

  const journeyResults = [];
  for (const journey of requirements.journeys.filter((item) => matchesRequirementScope(pageUrl, item))) {
    const journeyPage = await context.newPage();
    try {
      await openAuditPage(journeyPage, journey.startUrl ? new URL(journey.startUrl, pageUrl).toString() : pageUrl, options.timeout, journey.wait ?? options.wait);
      const result = await runJourney(journeyPage, journey);
      journeyResults.push({
        id: journey.id || journey.name || "custom-journey",
        name: result.name,
        severity: journey.severity || "serious",
        success: result.success,
        failedSteps: result.failedSteps,
        results: result.results,
        sourceFile: journey.sourceFile || null,
      });
    } finally {
      await journeyPage.close().catch(() => {});
    }
  }

  const failedRuleCount = ruleResults.filter((item) => !item.success).length;
  const failedJourneyCount = journeyResults.filter((item) => !item.success).length;
  const passCount =
    ruleResults.filter((item) => item.success).length + journeyResults.filter((item) => item.success).length;

  return {
    name: requirements.name,
    file: requirements.file,
    ruleResults,
    journeyResults,
    failedRuleCount,
    failedJourneyCount,
    passCount,
    failureCount: failedRuleCount + failedJourneyCount,
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

function buildSummary(
  axeViolations,
  keyboard,
  semantics,
  form,
  nonTextContrast,
  mobileChecks = [],
  reflowChecks = [],
  requirements = null,
) {
  const impactCounts = summarizeImpactCounts(axeViolations);
  const simplifiedViolations = simplifyAxeResults(axeViolations);
  const contrastViolations = axeViolations.filter((item) => item.id === "color-contrast");
  const screenReaderWarnings = [];
  const formWarnings = [];
  const nonTextContrastWarnings = [];
  const customRequirementWarnings = [];

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

  if (nonTextContrast.counts.lowContrastBoundaries > 0) {
    nonTextContrastWarnings.push(
      `Detected ${nonTextContrast.counts.lowContrastBoundaries} interactive component boundary candidate(s) below 3:1 contrast.`,
    );
  }

  if (nonTextContrast.counts.lowContrastIcons > 0) {
    nonTextContrastWarnings.push(
      `Detected ${nonTextContrast.counts.lowContrastIcons} icon-like control candidate(s) below 3:1 contrast.`,
    );
  }

  if (requirements?.failedRuleCount > 0) {
    customRequirementWarnings.push(`Detected ${requirements.failedRuleCount} custom rule failure(s).`);
  }

  if (requirements?.failedJourneyCount > 0) {
    customRequirementWarnings.push(`Detected ${requirements.failedJourneyCount} custom journey failure(s).`);
  }

  return {
    axeViolationCount: axeViolations.length,
    axeImpactCounts: impactCounts,
    severityBuckets: buildSeverityBuckets(simplifiedViolations),
    wcagSummary: buildWcagSummary(simplifiedViolations),
    contrastViolationCount: contrastViolations.length,
    formWarningCount: formWarnings.length,
    nonTextContrastWarningCount:
      nonTextContrast.counts.lowContrastBoundaries + nonTextContrast.counts.lowContrastIcons,
    mobileWarningCount: mobileChecks.filter((check) => check.warningCount > 0).length,
    customRequirementFailureCount: requirements?.failureCount || 0,
    customRequirementPassCount: requirements?.passCount || 0,
    journeyFailureCount: 0,
    keyboardWarningCount: keyboard.warnings.length,
    reflowWarningCount: reflowChecks.filter((check) => check.warningCount > 0).length,
    customRequirementWarnings,
    formWarnings,
    nonTextContrastWarnings,
    screenReaderWarningCount: screenReaderWarnings.length,
    screenReaderWarnings,
  };
}

export function renderMarkdown(report) {
  const lines = [];
  const { metadata, summary, keyboard, semantics, form, nonTextContrast, axe } = report;

  lines.push(`# Accessibility Audit: ${metadata.title || metadata.url}`);
  lines.push("");
  lines.push(`- URL: ${metadata.url}`);
  lines.push(`- Title: ${metadata.title || "(no title)"}`);
  lines.push(`- Tested at: ${metadata.testedAt}`);
  lines.push(`- Axe violations: ${summary.axeViolationCount}`);
  lines.push(`- Contrast violations: ${summary.contrastViolationCount}`);
  lines.push(`- Non-text contrast warnings: ${summary.nonTextContrastWarningCount}`);
  lines.push(`- Keyboard warnings: ${summary.keyboardWarningCount}`);
  lines.push(`- Reflow warnings: ${summary.reflowWarningCount}`);
  lines.push(`- Mobile warnings: ${summary.mobileWarningCount}`);
  lines.push(`- Form warnings: ${summary.formWarningCount}`);
  lines.push(`- Custom requirement failures: ${summary.customRequirementFailureCount}`);
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

  lines.push("## Custom Requirements");
  lines.push("");
  if (!report.requirements) {
    lines.push("No custom requirements were evaluated for this audit.");
    lines.push("");
  } else {
    lines.push(`- Requirement set: ${report.requirements.name}`);
    lines.push(`- Passed checks: ${summary.customRequirementPassCount}`);
    lines.push(`- Failed checks: ${summary.customRequirementFailureCount}`);
    lines.push("");

    if (summary.customRequirementWarnings.length === 0) {
      lines.push("No custom requirement failures were generated.");
      lines.push("");
    } else {
      for (const warning of summary.customRequirementWarnings) {
        lines.push(`- ${warning}`);
      }
      lines.push("");
    }

    for (const item of report.requirements.ruleResults.filter((entry) => !entry.success)) {
      lines.push(`- ${item.severity}: ${item.id}${item.selector ? ` (${item.selector})` : ""}`);
      lines.push(`  ${item.error || item.message || "Requirement failed."}`);
    }
    for (const item of report.requirements.journeyResults.filter((entry) => !entry.success)) {
      lines.push(`- ${item.severity}: ${item.name} journey failed with ${item.failedSteps} failed step(s).`);
    }
    if (
      report.requirements.ruleResults.some((entry) => !entry.success) ||
      report.requirements.journeyResults.some((entry) => !entry.success)
    ) {
      lines.push("");
    }
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

  lines.push("## Mobile Checks");
  lines.push("");
  if (!report.mobile || report.mobile.length === 0) {
    lines.push("No mobile checks were requested for this audit.");
    lines.push("");
  } else {
    for (const check of report.mobile) {
      lines.push(`### ${check.label} (${check.width}x${check.height})`);
      lines.push("");
      lines.push(`- Horizontal scroll: ${check.horizontalScrollDetected ? "yes" : "no"}`);
      lines.push(`- Small touch target sample count: ${check.touchTargetFailures.length}`);
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

  lines.push("## Non-Text Contrast");
  lines.push("");
  lines.push(`- Low-contrast component boundaries: ${nonTextContrast.counts.lowContrastBoundaries}`);
  lines.push(`- Low-contrast icon-like controls: ${nonTextContrast.counts.lowContrastIcons}`);
  lines.push("");

  if (summary.nonTextContrastWarnings.length === 0) {
    lines.push("No non-text contrast warnings were generated.");
    lines.push("");
  } else {
    for (const warning of summary.nonTextContrastWarnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  const nonTextExamples = [
    ...nonTextContrast.lowContrastBoundaries.map(
      (item) => `Component boundary contrast below 3:1 for ${item.selector} (${item.contrastRatio}:1).`,
    ),
    ...nonTextContrast.lowContrastIcons.map(
      (item) => `Icon-like control contrast below 3:1 for ${item.selector} (${item.contrastRatio}:1).`,
    ),
  ].slice(0, 10);

  for (const example of nonTextExamples) {
    lines.push(`- ${example}`);
  }
  if (nonTextExamples.length > 0) {
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
  lines.push(`- Pages with mobile warnings: ${summary.pagesWithMobileWarnings}`);
  lines.push(`- Pages with form warnings: ${summary.pagesWithFormWarnings}`);
  lines.push(`- Pages with non-text contrast warnings: ${summary.pagesWithNonTextContrastWarnings}`);
  lines.push(`- Pages with custom requirement failures: ${summary.pagesWithCustomRequirementFailures}`);
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
    lines.push(`- Mobile warnings: ${page.summary.mobileWarningCount}`);
    lines.push(`- Form warnings: ${page.summary.formWarningCount}`);
    lines.push(`- Non-text contrast warnings: ${page.summary.nonTextContrastWarningCount}`);
    lines.push(`- Custom requirement failures: ${page.summary.customRequirementFailureCount}`);
    lines.push(`- Screen-reader warnings: ${page.summary.screenReaderWarningCount}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function collectSinglePageCsvRows(report, context = {}) {
  const rows = [];
  const scope = context.scope || "page";
  const pageUrl = context.url || report.metadata.url;
  const pageTitle = context.title || report.metadata.title || "";

  for (const violation of report.axe.violations) {
    for (const node of violation.nodes) {
      rows.push([
        scope,
        pageUrl,
        pageTitle,
        "axe",
        violation.id,
        violation.impact,
        violation.affectedNodes,
        violation.tags.join(" "),
        node.target.join(" | "),
        node.failureSummary || node.html || violation.help,
      ]);
    }
  }

  for (const warning of report.keyboard.warnings) {
    rows.push([scope, pageUrl, pageTitle, "keyboard", "warning", "warning", 1, "", "", warning]);
  }

  for (const check of report.reflow || []) {
    for (const warning of check.warnings) {
      rows.push([scope, pageUrl, pageTitle, "reflow", `width-${check.width}`, "warning", 1, "", "", warning]);
    }
  }

  for (const check of report.mobile || []) {
    for (const warning of check.warnings) {
      rows.push([scope, pageUrl, pageTitle, "mobile", check.label, "warning", 1, "", "", warning]);
    }
    for (const item of check.touchTargetFailures || []) {
      rows.push([
        scope,
        pageUrl,
        pageTitle,
        "mobile",
        "touch-target",
        "warning",
        1,
        "",
        item.selector,
        `${item.width}x${item.height} CSS pixels.`,
      ]);
    }
  }

  for (const warning of report.summary.screenReaderWarnings) {
    rows.push([scope, pageUrl, pageTitle, "screen-reader-proxy", "warning", "warning", 1, "", "", warning]);
  }

  for (const warning of report.summary.formWarnings) {
    rows.push([scope, pageUrl, pageTitle, "form", "warning", "warning", 1, "", "", warning]);
  }

  for (const item of report.form?.missingAutocomplete || []) {
    rows.push([
      scope,
      pageUrl,
      pageTitle,
      "form",
      "missing-autocomplete",
      "warning",
      1,
      "",
      item.selector,
      `Expected autocomplete token ${item.expected}.`,
    ]);
  }

  for (const item of report.form?.placeholderOnlyControls || []) {
    rows.push([scope, pageUrl, pageTitle, "form", "placeholder-only-label", "warning", 1, "", item.selector, item.placeholder || ""]);
  }

  for (const item of report.form?.requiredCueOnly || []) {
    rows.push([scope, pageUrl, pageTitle, "form", "required-cue-only", "warning", 1, "", item.selector, "Visible required cue without programmatic required state."]);
  }

  for (const item of report.form?.invalidWithoutState || []) {
    rows.push([scope, pageUrl, pageTitle, "form", "invalid-without-aria-invalid", "warning", 1, "", item.selector, item.message || ""]);
  }

  for (const item of report.form?.unassociatedErrorMessages || []) {
    rows.push([scope, pageUrl, pageTitle, "form", "unassociated-error-message", "warning", 1, "", item.selector, item.message || ""]);
  }

  for (const warning of report.summary.nonTextContrastWarnings) {
    rows.push([scope, pageUrl, pageTitle, "non-text-contrast", "warning", "warning", 1, "", "", warning]);
  }

  if (report.requirements) {
    for (const item of report.requirements.ruleResults.filter((entry) => !entry.success)) {
      rows.push([
        scope,
        pageUrl,
        pageTitle,
        "custom-requirement",
        item.id,
        item.severity,
        1,
        "",
        item.selector || "",
        item.error || item.message || "Requirement failed.",
      ]);
    }

    for (const item of report.requirements.journeyResults.filter((entry) => !entry.success)) {
      rows.push([
        scope,
        pageUrl,
        pageTitle,
        "custom-requirement",
        item.name,
        item.severity,
        1,
        "",
        "",
        `${item.failedSteps} failed step(s).`,
      ]);
    }
  }

  for (const item of report.nonTextContrast?.lowContrastBoundaries || []) {
    rows.push([
      scope,
      pageUrl,
      pageTitle,
      "non-text-contrast",
      "component-boundary",
      "warning",
      1,
      "",
      item.selector,
      `Contrast ratio ${item.contrastRatio}:1.`,
    ]);
  }

  for (const item of report.nonTextContrast?.lowContrastIcons || []) {
    rows.push([
      scope,
      pageUrl,
      pageTitle,
      "non-text-contrast",
      "icon-control",
      "warning",
      1,
      "",
      item.selector,
      `Contrast ratio ${item.contrastRatio}:1.`,
    ]);
  }

  if (report.journey) {
    for (const item of report.journey.results.filter((step) => !step.success)) {
      rows.push([
        scope,
        pageUrl,
        pageTitle,
        "journey",
        item.action,
        "failure",
        1,
        "",
        "",
        item.error || item.label || "",
      ]);
    }
  }

  return rows;
}

export function renderCsv(report) {
  const rows = [
    ["scope", "url", "title", "category", "rule_or_check", "severity", "count", "wcag_tags", "target", "message"],
  ];

  if (isAggregateReport(report)) {
    for (const page of report.pages) {
      rows.push(...collectSinglePageCsvRows(page, { scope: "crawl-page" }));
    }
  } else {
    rows.push(...collectSinglePageCsvRows(report));
  }

  return toCsv(rows);
}

function renderSummaryChips(items) {
  return items
    .map(
      (item) => `<div class="chip"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.value)}</span></div>`,
    )
    .join("");
}

function renderSinglePageHtml(report) {
  const summaryChips = renderSummaryChips([
    { label: "Axe", value: report.summary.axeViolationCount },
    { label: "Contrast", value: report.summary.contrastViolationCount },
    { label: "Keyboard", value: report.summary.keyboardWarningCount },
    { label: "Reflow", value: report.summary.reflowWarningCount },
    { label: "Mobile", value: report.summary.mobileWarningCount },
    { label: "Form", value: report.summary.formWarningCount },
    { label: "Requirements", value: report.summary.customRequirementFailureCount },
    { label: "Non-text contrast", value: report.summary.nonTextContrastWarningCount },
    { label: "Screen reader", value: report.summary.screenReaderWarningCount },
  ]);

  const violationItems =
    report.axe.violations.length === 0
      ? "<p>No axe violations detected for this sampled state.</p>"
      : report.axe.violations
          .map(
            (violation) => `
              <article class="finding">
                <h3>${escapeHtml(violation.id)} <span>${escapeHtml(violation.impact)}</span></h3>
                <p>${escapeHtml(violation.help)} (${violation.affectedNodes} node(s))</p>
              </article>`,
          )
          .join("");

  const warningLists = [
    { title: "Keyboard warnings", items: report.keyboard.warnings },
    { title: "Mobile warnings", items: (report.mobile || []).flatMap((check) => check.warnings) },
    { title: "Screen-reader proxy warnings", items: report.summary.screenReaderWarnings },
    { title: "Form warnings", items: report.summary.formWarnings },
    { title: "Custom requirement failures", items: report.summary.customRequirementWarnings },
    { title: "Non-text contrast warnings", items: report.summary.nonTextContrastWarnings },
  ]
    .map(({ title, items }) => {
      const content =
        items.length === 0
          ? "<p>None.</p>"
          : `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
      return `<section class="panel"><h2>${escapeHtml(title)}</h2>${content}</section>`;
    })
    .join("");

  const reflowItems =
    report.reflow.length === 0
      ? "<p>No reflow checks requested.</p>"
      : report.reflow
          .map(
            (check) => `
              <article class="finding">
                <h3>${escapeHtml(`${check.width}px`)}</h3>
                <p>Horizontal scroll: ${check.horizontalScrollDetected ? "yes" : "no"}</p>
                <p>${escapeHtml(check.warnings.join(" ") || "No warnings.")}</p>
              </article>`,
          )
          .join("");

  const mobileItems =
    !report.mobile || report.mobile.length === 0
      ? "<p>No mobile checks requested.</p>"
      : report.mobile
          .map(
            (check) => `
              <article class="finding">
                <h3>${escapeHtml(`${check.label} (${check.width}x${check.height})`)}</h3>
                <p>Horizontal scroll: ${check.horizontalScrollDetected ? "yes" : "no"}</p>
                <p>${escapeHtml(check.warnings.join(" ") || "No warnings.")}</p>
              </article>`,
          )
          .join("");

  const journeySection = report.journey
    ? `
      <section class="panel">
        <h2>Journey</h2>
        <p>${escapeHtml(report.journey.name)}. Failed steps: ${escapeHtml(report.journey.failedSteps)}</p>
      </section>`
    : "";

  const requirementsSection = !report.requirements
    ? ""
    : `
      <section class="panel" style="margin-top:20px;">
        <h2>Custom Requirements</h2>
        <p>${escapeHtml(report.requirements.name)}. Failed checks: ${escapeHtml(report.summary.customRequirementFailureCount)}</p>
      </section>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(report.metadata.title || report.metadata.url)} Accessibility Audit</title>
    <style>
      :root { color-scheme: light; --bg:#f4f0e8; --panel:#fffdf9; --ink:#171412; --muted:#6a6258; --line:#d8cfc2; --accent:#8a4f21; }
      * { box-sizing:border-box; }
      body { margin:0; font:16px/1.5 Georgia, "Times New Roman", serif; background:linear-gradient(180deg, #f4f0e8, #ede4d6); color:var(--ink); }
      main { max-width:1100px; margin:0 auto; padding:32px 20px 48px; }
      h1,h2,h3,p,ul { margin-top:0; }
      .hero, .panel { background:rgba(255,253,249,0.92); border:1px solid var(--line); border-radius:20px; padding:20px; box-shadow:0 12px 30px rgba(35, 24, 10, 0.08); }
      .hero { margin-bottom:20px; }
      .grid { display:grid; gap:20px; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); }
      .chips { display:grid; gap:12px; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); margin-top:16px; }
      .chip { border:1px solid var(--line); border-radius:16px; padding:12px 14px; background:#fff; }
      .chip strong, .finding h3 span { display:block; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); }
      .chip span { font-size:1.6rem; color:var(--accent); }
      .finding { border-top:1px solid var(--line); padding-top:14px; margin-top:14px; }
      .finding:first-child { border-top:0; padding-top:0; margin-top:0; }
      a { color:inherit; }
      ul { padding-left:20px; }
      .meta { color:var(--muted); }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="meta">${escapeHtml(report.metadata.url)}</p>
        <h1>${escapeHtml(report.metadata.title || report.metadata.url)}</h1>
        <p class="meta">Tested at ${escapeHtml(report.metadata.testedAt)}</p>
        <div class="chips">${summaryChips}</div>
      </section>
      <div class="grid">
        <section class="panel"><h2>Axe findings</h2>${violationItems}</section>
        <section class="panel"><h2>Reflow</h2>${reflowItems}</section>
      </div>
      <section class="panel" style="margin-top:20px;"><h2>Mobile</h2>${mobileItems}</section>
      ${journeySection}
      ${requirementsSection}
      <div class="grid" style="margin-top:20px;">${warningLists}</div>
    </main>
  </body>
</html>
`;
}

function renderAggregateHtml(aggregateReport) {
  const summaryChips = renderSummaryChips([
    { label: "Pages", value: aggregateReport.summary.pagesAudited },
    { label: "Axe", value: aggregateReport.summary.totalAxeViolations },
    { label: "Keyboard", value: aggregateReport.summary.pagesWithKeyboardWarnings },
    { label: "Reflow", value: aggregateReport.summary.pagesWithReflowWarnings },
    { label: "Mobile", value: aggregateReport.summary.pagesWithMobileWarnings },
    { label: "Form", value: aggregateReport.summary.pagesWithFormWarnings },
    { label: "Requirements", value: aggregateReport.summary.pagesWithCustomRequirementFailures },
    { label: "Non-text contrast", value: aggregateReport.summary.pagesWithNonTextContrastWarnings },
    { label: "Screen reader", value: aggregateReport.summary.pagesWithScreenReaderWarnings },
  ]);

  const pageCards = aggregateReport.pages
    .map(
      (page) => `
        <article class="finding">
          <h3>${escapeHtml(page.metadata.title || page.metadata.url)}</h3>
          <p><a href="${escapeHtml(page.metadata.url)}">${escapeHtml(page.metadata.url)}</a></p>
          <p>Axe: ${page.summary.axeViolationCount} | Keyboard: ${page.summary.keyboardWarningCount} | Mobile: ${page.summary.mobileWarningCount} | Form: ${page.summary.formWarningCount} | Requirements: ${page.summary.customRequirementFailureCount} | Non-text contrast: ${page.summary.nonTextContrastWarningCount}</p>
        </article>`,
    )
    .join("");

  const topRules =
    aggregateReport.summary.topViolationRules.length === 0
      ? "<p>No aggregate axe findings.</p>"
      : `<ul>${aggregateReport.summary.topViolationRules
          .map((item) => `<li>${escapeHtml(item.id)}: ${escapeHtml(item.count)}</li>`)
          .join("")}</ul>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(aggregateReport.metadata.seedUrl)} Accessibility Crawl</title>
    <style>
      :root { color-scheme: light; --bg:#f5efe4; --panel:#fffdf8; --ink:#171412; --muted:#6d6258; --line:#d9cfbe; --accent:#24524a; }
      * { box-sizing:border-box; }
      body { margin:0; font:16px/1.5 Georgia, "Times New Roman", serif; background:linear-gradient(180deg, #f5efe4, #ebe0cb); color:var(--ink); }
      main { max-width:1100px; margin:0 auto; padding:32px 20px 48px; }
      h1,h2,h3,p,ul { margin-top:0; }
      .hero, .panel { background:rgba(255,253,248,0.94); border:1px solid var(--line); border-radius:20px; padding:20px; box-shadow:0 12px 30px rgba(27, 21, 11, 0.08); }
      .hero { margin-bottom:20px; }
      .grid { display:grid; gap:20px; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); }
      .chips { display:grid; gap:12px; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); margin-top:16px; }
      .chip { border:1px solid var(--line); border-radius:16px; padding:12px 14px; background:#fff; }
      .chip strong { display:block; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); }
      .chip span { font-size:1.6rem; color:var(--accent); }
      .finding { border-top:1px solid var(--line); padding-top:14px; margin-top:14px; }
      .finding:first-child { border-top:0; padding-top:0; margin-top:0; }
      a { color:inherit; }
      ul { padding-left:20px; }
      .meta { color:var(--muted); }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="meta">${escapeHtml(aggregateReport.metadata.seedUrl)}</p>
        <h1>Accessibility Crawl</h1>
        <p class="meta">Tested at ${escapeHtml(aggregateReport.metadata.testedAt)}</p>
        <div class="chips">${summaryChips}</div>
      </section>
      <div class="grid">
        <section class="panel"><h2>Top violation rules</h2>${topRules}</section>
        <section class="panel"><h2>Pages</h2>${pageCards}</section>
      </div>
    </main>
  </body>
</html>
`;
}

export function renderHtmlReport(report) {
  return isAggregateReport(report) ? renderAggregateHtml(report) : renderSinglePageHtml(report);
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
    requirements = null,
    reflowCheck = false,
    reflowWidths = [320, 768],
    mobileCheck = false,
    mobileViewports = [
      { label: "mobile-portrait", width: 390, height: 844 },
      { label: "small-android", width: 360, height: 800 },
    ],
    screenshots = false,
    assetDir = null,
    screenshotLimit = 10,
  } = options;

  const testedAt = new Date();
  const page = await context.newPage();

  try {
    await openAuditPage(page, url, timeout, wait);

    const title = await page.title();
    const axeRaw = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
      .analyze();
    const axeViolations = applyAxeSeverityOverrides(axeRaw.violations, requirements?.severityOverrides?.axe || {});

    const keyboard = await runKeyboardAudit(page, tabLimit);
    const semantics = await collectSemanticSignals(page);
    const reflow = reflowCheck ? await collectReflowChecks(page, reflowWidths) : [];
    const mobile = mobileCheck ? await collectMobileChecks(page, mobileViewports) : [];
    const form = await collectFormSignals(page);
    const nonTextContrast = await collectNonTextContrastSignals(page);
    const requirementsReport = await runRequirementsAssessment(context, page, { timeout, wait }, requirements);
    const journeyReport = journey ? await runJourney(page, journey) : null;
    const summary = buildSummary(axeViolations, keyboard, semantics, form, nonTextContrast, mobile, reflow, requirementsReport);
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
        violations: simplifyAxeResults(axeViolations),
        incomplete: simplifyAxeResults(axeRaw.incomplete),
        inapplicable: axeRaw.inapplicable.length,
      },
      keyboard,
      reflow,
      mobile,
      semantics,
      form,
      nonTextContrast,
    };

    if (requirementsReport) {
      report.requirements = requirementsReport;
    }

    if (journeyReport) {
      report.journey = journeyReport;
      report.summary.journeyFailureCount = report.journey.failedSteps;
    }

    if (screenshots && assetDir) {
      report.evidence = await captureEvidence(page, axeViolations, keyboard, assetDir, screenshotLimit);
    }

    return report;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function writeReportFiles(outBase, report, renderFn = renderMarkdown) {
  const markdown = renderFn(report);
  const html = renderHtmlReport(report);
  const csv = renderCsv(report);
  await fs.mkdir(path.dirname(outBase), { recursive: true });
  await fs.writeFile(`${outBase}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(`${outBase}.md`, markdown, "utf8");
  await fs.writeFile(`${outBase}.html`, html, "utf8");
  await fs.writeFile(`${outBase}.csv`, csv, "utf8");
}
