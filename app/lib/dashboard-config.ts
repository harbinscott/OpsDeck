import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  DashboardApplicationConfig,
  DashboardApplicationMatch,
  DashboardConfig,
} from "./snapshot";

const defaultConfig: DashboardConfig = {
  version: 1,
  applications: [],
  containerAliases: {},
  savedLogViews: [],
};

function boundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function normalizeSavedViews(value: unknown): NonNullable<DashboardConfig["savedLogViews"]> {
  if (!Array.isArray(value)) return [];
  const levels = new Set(["all", "info", "warning", "error"]);
  return value.slice(0, 20).flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const view = entry as Record<string, unknown>;
    const name = typeof view.name === "string" ? view.name.trim().slice(0, 60) : "";
    if (!name) return [];
    const level = typeof view.level === "string" && levels.has(view.level) ? view.level as "all" | "info" | "warning" | "error" : "all";
    const id = typeof view.id === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(view.id) ? view.id : `view-${index + 1}`;
    const query = typeof view.query === "string" ? view.query.trim().slice(0, 200) : "";
    return [{ id, name, level, query }];
  });
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return normalized.length ? normalized : undefined;
}

function managedServices(value: unknown): string[] {
  if (!Array.isArray(value)) return ["nginx.service", "docker.service"];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => /^[a-zA-Z0-9@_.-]{1,180}\.service$/.test(item)))].slice(0, 50);
}

function normalizeMatch(value: unknown): DashboardApplicationMatch {
  const match = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    composeProjects: strings(match.composeProjects),
    composeServices: strings(match.composeServices),
    containerNames: strings(match.containerNames),
  };
}

function normalizeApplication(value: unknown, index: number): DashboardApplicationConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const application = value as Record<string, unknown>;
  const name = typeof application.name === "string" ? application.name.trim() : "";
  if (!name) return undefined;
  const id = typeof application.id === "string" && application.id.trim()
    ? application.id.trim()
    : `application-${index + 1}`;
  return {
    id,
    name,
    description: typeof application.description === "string" ? application.description.trim() : undefined,
    color: typeof application.color === "string" ? application.color.trim() : undefined,
    accent: typeof application.accent === "string" ? application.accent.trim().slice(0, 3).toUpperCase() : undefined,
    match: normalizeMatch(application.match),
  };
}

function normalizeAliases(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, alias]) => [name.trim(), alias.trim()])
    .filter(([name, alias]) => Boolean(name && alias)));
}

export function parseDashboardConfig(value: unknown): DashboardConfig {
  if (!value || typeof value !== "object") throw new Error("The dashboard configuration must be a JSON object.");
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new Error("Only dashboard configuration version 1 is supported.");
  const applications = Array.isArray(input.applications)
    ? input.applications.map(normalizeApplication).filter((item): item is DashboardApplicationConfig => Boolean(item))
    : [];
  const displayName = input.host && typeof input.host === "object" && typeof (input.host as Record<string, unknown>).displayName === "string"
    ? ((input.host as Record<string, unknown>).displayName as string).trim()
    : "";
  const rawSettings = input.settings && typeof input.settings === "object" ? input.settings as Record<string, unknown> : {};
  return {
    version: 1,
    host: displayName ? { displayName } : undefined,
    applications,
    containerAliases: normalizeAliases(input.containerAliases),
    settings: {
      refreshIntervalSeconds: boundedNumber(rawSettings.refreshIntervalSeconds, 5, 60),
      elevationTimeoutSeconds: boundedNumber(rawSettings.elevationTimeoutSeconds, 60, 3600),
      managedServices: managedServices(rawSettings.managedServices),
    },
    savedLogViews: normalizeSavedViews(input.savedLogViews),
  };
}

export async function loadDashboardConfig(): Promise<{ configuration: DashboardConfig; error?: string }> {
  const path = process.env.OPSDECK_CONFIG_PATH?.trim();
  if (!path) return { configuration: defaultConfig };
  try {
    const contents = await readFile(path, "utf8");
    return { configuration: parseDashboardConfig(JSON.parse(contents)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { configuration: defaultConfig };
    const detail = error instanceof Error ? error.message : "Unknown configuration error";
    return { configuration: defaultConfig, error: `Dashboard configuration was not loaded: ${detail}` };
  }
}

export async function saveDashboardConfig(value: unknown): Promise<DashboardConfig> {
  const path = process.env.OPSDECK_CONFIG_PATH?.trim();
  if (!path) throw new Error("OPSDECK_CONFIG_PATH is not configured.");
  const configuration = parseDashboardConfig(value);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return configuration;
}
