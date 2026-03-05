import fs from "node:fs/promises";
import path from "node:path";

function normalizeReflowWidths(value) {
  if (Array.isArray(value)) {
    return value.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isFinite(item) && item > 0);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((item) => Number.isFinite(item) && item > 0);
  }

  return undefined;
}

function normalizeMobileViewports(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map((item, index) => {
      if (typeof item === "string") {
        const [width, height] = item.toLowerCase().split("x").map((part) => Number.parseInt(part.trim(), 10));
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
          return null;
        }
        return { label: `mobile-${index + 1}`, width, height };
      }

      if (item && typeof item === "object") {
        const width = Number.parseInt(item.width, 10);
        const height = Number.parseInt(item.height, 10);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
          return null;
        }
        return {
          label: item.label || `mobile-${index + 1}`,
          width,
          height,
        };
      }

      return null;
    })
    .filter(Boolean);
}

function normalizeSettings(settings = {}) {
  return {
    ...settings,
    reflowWidths: settings.reflowWidths === undefined ? undefined : normalizeReflowWidths(settings.reflowWidths),
    mobileViewports:
      settings.mobileViewports === undefined ? undefined : normalizeMobileViewports(settings.mobileViewports),
  };
}

async function resolveJourneyEntry(entry, baseDir) {
  if (!entry || typeof entry !== "object") {
    throw new Error("Each requirements journey must be an object.");
  }

  if (!entry.file) {
    return entry;
  }

  const filePath = path.resolve(baseDir, entry.file);
  const rawJourney = JSON.parse(await fs.readFile(filePath, "utf8"));
  const { file, ...overrides } = entry;

  return {
    ...rawJourney,
    ...overrides,
    sourceFile: filePath,
  };
}

export async function loadRequirementsConfig(filePath) {
  if (!filePath) {
    return null;
  }

  const absolutePath = path.resolve(filePath);
  const baseDir = path.dirname(absolutePath);
  const rawConfig = JSON.parse(await fs.readFile(absolutePath, "utf8"));
  const settings = normalizeSettings(rawConfig.settings || {});
  const journeys = await Promise.all((rawConfig.journeys || []).map((entry) => resolveJourneyEntry(entry, baseDir)));

  return {
    name: rawConfig.name || path.basename(absolutePath, path.extname(absolutePath)),
    file: absolutePath,
    settings,
    rules: Array.isArray(rawConfig.rules) ? rawConfig.rules : [],
    journeys,
    severityOverrides: rawConfig.severityOverrides || {},
  };
}

export function applyRequirementsSettings(args, requirements, mode) {
  if (!requirements) {
    return args;
  }

  const merged = { ...args };
  const provided = args.provided || new Set();
  const commonKeys = [
    "tabLimit",
    "timeout",
    "wait",
    "reflowCheck",
    "reflowWidths",
    "mobileCheck",
    "mobileViewports",
    "screenshots",
    "screenshotLimit",
  ];
  const crawlOnlyKeys = ["maxPages"];
  const allowedKeys = mode === "crawl" ? [...commonKeys, ...crawlOnlyKeys] : commonKeys;

  for (const key of allowedKeys) {
    if (!provided.has(key) && requirements.settings[key] !== undefined) {
      merged[key] = requirements.settings[key];
    }
  }

  merged.requirements = requirements;
  return merged;
}
