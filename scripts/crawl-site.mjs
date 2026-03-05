#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import {
  auditPageInContext,
  closeBrowserContext,
  createBrowserContext,
  renderAggregateMarkdown,
  slugifyUrl,
  timestampForFile,
  writeReportFiles,
} from "./lib/audit-core.mjs";

function parseArgs(argv) {
  const args = {
    maxPages: 5,
    tabLimit: 20,
    timeout: 45000,
    wait: 1000,
    screenshots: false,
    screenshotLimit: 10,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--") && !args.url) {
      args.url = token;
      continue;
    }

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (token === "--url") {
      args.url = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--out") {
      args.out = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--max-pages") {
      args.maxPages = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }

    if (token === "--tab-limit") {
      args.tabLimit = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }

    if (token === "--timeout") {
      args.timeout = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }

    if (token === "--wait") {
      args.wait = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }

    if (token === "--screenshots") {
      args.screenshots = true;
      continue;
    }

    if (token === "--screenshot-limit") {
      args.screenshotLimit = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/crawl-site.mjs --url <seed-url> [--max-pages 5] [--out reports/name] [--tab-limit 20] [--timeout 45000] [--wait 1000] [--screenshots] [--screenshot-limit 10]",
      "",
      "Examples:",
      "  npm run crawl -- --url https://www.wsp.com --max-pages 5",
      "  node scripts/crawl-site.mjs https://www.wsp.com --out reports/wsp-crawl",
    ].join("\n"),
  );
}

function normalizeCandidate(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = "";
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

function isLikelyHtmlPage(rawUrl, origin) {
  const url = new URL(rawUrl);
  const pathname = url.pathname.toLowerCase();
  const blockedExtensions = [
    ".pdf",
    ".zip",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".svg",
    ".webp",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".xml",
    ".json",
    ".txt",
    ".mp4",
    ".mp3",
  ];

  return url.origin === origin && !blockedExtensions.some((extension) => pathname.endsWith(extension));
}

async function collectSameOriginLinks(page, origin) {
  return page.evaluate((pageOrigin) => {
    function scoreAnchor(anchor) {
      let score = 0;
      if (anchor.closest("header, nav, main")) {
        score += 3;
      }
      if (anchor.textContent && anchor.textContent.trim()) {
        score += 1;
      }
      if (anchor.getAttribute("aria-label")) {
        score += 1;
      }
      return score;
    }

    const anchors = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => {
        const href = anchor.href;
        if (!href || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
          return null;
        }

        try {
          const url = new URL(href, document.baseURI);
          url.hash = "";
          return {
            url: url.toString(),
            text: (anchor.textContent || anchor.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
            score: scoreAnchor(anchor),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((entry) => new URL(entry.url).origin === pageOrigin);

    anchors.sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
    return anchors;
  }, origin);
}

function buildAggregateSummary(pages) {
  const ruleCounts = new Map();
  let totalAxeViolations = 0;
  let pagesWithKeyboardWarnings = 0;
  let pagesWithScreenReaderWarnings = 0;

  for (const page of pages) {
    totalAxeViolations += page.summary.axeViolationCount;
    if (page.summary.keyboardWarningCount > 0) {
      pagesWithKeyboardWarnings += 1;
    }
    if (page.summary.screenReaderWarningCount > 0) {
      pagesWithScreenReaderWarnings += 1;
    }

    for (const violation of page.axe.violations) {
      ruleCounts.set(violation.id, (ruleCounts.get(violation.id) || 0) + violation.affectedNodes);
    }
  }

  const topViolationRules = Array.from(ruleCounts.entries())
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id))
    .slice(0, 10);

  return {
    pagesAudited: pages.length,
    totalAxeViolations,
    pagesWithKeyboardWarnings,
    pagesWithScreenReaderWarnings,
    topViolationRules,
  };
}

async function crawlSite(context, options, outBase) {
  const seedUrl = normalizeCandidate(options.url);
  const origin = new URL(seedUrl).origin;
  const queue = [seedUrl];
  const queued = new Set(queue);
  const visited = new Set();
  const reports = [];

  while (queue.length > 0 && reports.length < options.maxPages) {
    const currentUrl = queue.shift();
    if (!currentUrl || visited.has(currentUrl)) {
      continue;
    }

    const report = await auditPageInContext(context, {
      url: currentUrl,
      tabLimit: options.tabLimit,
      timeout: options.timeout,
      wait: options.wait,
      screenshots: options.screenshots,
      assetDir: options.screenshots
        ? path.join(`${outBase}-assets`, `${String(reports.length + 1).padStart(2, "0")}-${slugifyUrl(currentUrl)}`)
        : null,
      screenshotLimit: options.screenshotLimit,
    });

    reports.push(report);
    visited.add(currentUrl);

    const page = await context.newPage();
    try {
      await page.goto(report.metadata.url, {
        waitUntil: "domcontentloaded",
        timeout: options.timeout,
      });
      await page.waitForLoadState("networkidle", {
        timeout: Math.min(options.timeout, 15000),
      }).catch(() => {});
      if (options.wait > 0) {
        await page.waitForTimeout(options.wait);
      }

      const candidates = await collectSameOriginLinks(page, origin);
      for (const candidate of candidates) {
        if (reports.length + queue.length >= options.maxPages * 4) {
          break;
        }

        if (!isLikelyHtmlPage(candidate.url, origin)) {
          continue;
        }

        const normalized = normalizeCandidate(candidate.url);
        if (!visited.has(normalized) && !queued.has(normalized)) {
          queue.push(normalized);
          queued.add(normalized);
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  return reports;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (!args.url) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!Number.isFinite(args.maxPages) || args.maxPages < 1) {
    throw new Error("--max-pages must be a positive integer.");
  }

  if (!Number.isFinite(args.screenshotLimit) || args.screenshotLimit < 1) {
    throw new Error("--screenshot-limit must be a positive integer.");
  }

  const testedAt = new Date();
  const outBase =
    args.out ||
    path.join(
      process.cwd(),
      "reports",
      `${slugifyUrl(args.url)}-crawl-${timestampForFile(testedAt)}`,
    );

  const resources = await createBrowserContext();

  try {
    const pages = await crawlSite(resources.context, args, outBase);
    const aggregateReport = {
      metadata: {
        seedUrl: args.url,
        testedAt: testedAt.toISOString(),
        maxPages: args.maxPages,
      },
      summary: buildAggregateSummary(pages),
      pages,
    };

    await writeReportFiles(outBase, aggregateReport, renderAggregateMarkdown);

    console.log(
      JSON.stringify(
        {
          jsonReport: `${outBase}.json`,
          markdownReport: `${outBase}.md`,
          summary: aggregateReport.summary,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeBrowserContext(resources);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
