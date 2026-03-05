#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  auditPageInContext,
  closeBrowserContext,
  createBrowserContext,
  slugifyUrl,
  timestampForFile,
  writeReportFiles,
} from "./lib/audit-core.mjs";

function parseArgs(argv) {
  const args = {
    tabLimit: 20,
    timeout: 45000,
    wait: 1000,
    reflowCheck: true,
    reflowWidths: [320, 768],
    mobileCheck: true,
    mobileViewports: [
      { label: "mobile-portrait", width: 390, height: 844 },
      { label: "small-android", width: 360, height: 800 },
    ],
    screenshots: true,
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

    if (token === "--journey-file") {
      args.journeyFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--reflow-check") {
      args.reflowCheck = true;
      continue;
    }

    if (token === "--skip-reflow-check") {
      args.reflowCheck = false;
      continue;
    }

    if (token === "--reflow-widths") {
      args.reflowWidths = argv[index + 1]
        .split(",")
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isFinite(value) && value > 0);
      index += 1;
      continue;
    }

    if (token === "--mobile-check") {
      args.mobileCheck = true;
      continue;
    }

    if (token === "--skip-mobile-check") {
      args.mobileCheck = false;
      continue;
    }

    if (token === "--mobile-viewports") {
      args.mobileViewports = argv[index + 1]
        .split(",")
        .map((value, itemIndex) => {
          const [width, height] = value.toLowerCase().split("x").map((part) => Number.parseInt(part.trim(), 10));
          if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
            return null;
          }
          return { label: `mobile-${itemIndex + 1}`, width, height };
        })
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (token === "--screenshots") {
      args.screenshots = true;
      continue;
    }

    if (token === "--skip-screenshots") {
      args.screenshots = false;
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
      "  node scripts/audit-url.mjs --url <page-url> [--out reports/name] [--tab-limit 20] [--timeout 45000] [--wait 1000] [--journey-file path/to/journey.json] [--skip-reflow-check] [--reflow-widths 320,768] [--skip-mobile-check] [--mobile-viewports 390x844,360x800] [--skip-screenshots] [--screenshot-limit 10]",
      "",
      "Examples:",
      "  npm run audit -- --url https://example.com",
      "  node scripts/audit-url.mjs https://example.com --out reports/example-home",
    ].join("\n"),
  );
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

  if (!Number.isFinite(args.tabLimit) || args.tabLimit < 1) {
    throw new Error("--tab-limit must be a positive integer.");
  }

  if (!Number.isFinite(args.timeout) || args.timeout < 1000) {
    throw new Error("--timeout must be at least 1000 milliseconds.");
  }

  if (!Number.isFinite(args.wait) || args.wait < 0) {
    throw new Error("--wait must be zero or greater.");
  }

  if (!Number.isFinite(args.screenshotLimit) || args.screenshotLimit < 1) {
    throw new Error("--screenshot-limit must be a positive integer.");
  }

  if (args.reflowCheck && args.reflowWidths.length === 0) {
    throw new Error("--reflow-widths must contain at least one positive width.");
  }

  if (args.mobileCheck && args.mobileViewports.length === 0) {
    throw new Error("--mobile-viewports must contain at least one WIDTHxHEIGHT pair.");
  }

  const testedAt = new Date();
  const outBase =
    args.out ||
    path.join(process.cwd(), "reports", `${slugifyUrl(args.url)}-${timestampForFile(testedAt)}`);
  const journey = args.journeyFile ? JSON.parse(await fs.readFile(args.journeyFile, "utf8")) : null;

  const resources = await createBrowserContext();

  try {
    const report = await auditPageInContext(resources.context, {
      url: args.url,
      tabLimit: args.tabLimit,
      timeout: args.timeout,
      wait: args.wait,
      journey,
      reflowCheck: args.reflowCheck,
      reflowWidths: args.reflowWidths,
      mobileCheck: args.mobileCheck,
      mobileViewports: args.mobileViewports,
      screenshots: args.screenshots,
      assetDir: args.screenshots ? `${outBase}-assets` : null,
      screenshotLimit: args.screenshotLimit,
    });
    report.metadata.requestedUrl = args.url;
    report.metadata.requestedAt = testedAt.toISOString();

    await writeReportFiles(outBase, report);

    console.log(
      JSON.stringify(
        {
          jsonReport: `${outBase}.json`,
          markdownReport: `${outBase}.md`,
          htmlReport: `${outBase}.html`,
          csvReport: `${outBase}.csv`,
          summary: report.summary,
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
