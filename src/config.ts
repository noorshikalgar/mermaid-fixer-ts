import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";

export interface LlmConfig {
  provider: string;
  model: string;
  api_key?: string;
  base_url?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface MermaidConfig {
  timeout_seconds?: number;
  max_retries?: number;
}

export interface ScanConfig {
  exclude_patterns?: string[];
}

export interface ReportConfig {
  path?: string;
}

export interface Config {
  language: string;
  llm: LlmConfig;
  mermaid: MermaidConfig;
  scan: ScanConfig;
  report: ReportConfig;
}

export function getDefaultConfigPath(): string {
  return join(getAppConfigDir(), "config.toml");
}

export function getDefaultConfig(): Config {
  return {
    language: "en",
    llm: {
      provider: "ollama",
      model: "llama3",
      max_tokens: 4096,
      temperature: 0.1,
    },
    mermaid: {
      timeout_seconds: 120,
      max_retries: 3,
    },
    scan: {
      exclude_patterns: [],
    },
    report: {
      path: "",
    },
  };
}

/** Returns the base URL to use for the LLM API, applying per-provider defaults. */
export function getEffectiveBaseUrl(llm: LlmConfig): string {
  if (llm.base_url) return llm.base_url;
  switch (llm.provider.toLowerCase()) {
    case "ollama":
      return "http://localhost:11434/v1";
    case "openai":
      return "https://api.openai.com/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "mistral":
      return "https://api.mistral.ai/v1";
    default:
      return "http://localhost:11434/v1";
  }
}

/** Local providers (Ollama) don't need an API key. */
export function requiresApiKey(provider: string): boolean {
  return !["ollama"].includes(provider.toLowerCase());
}

export function getDefaultReportPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(getAppStateDir(), "reports", `mermaid-fixer-report-${stamp}.json`);
}

function getAppConfigDir(): string {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "mermaid-fixer-ts",
    );
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "mermaid-fixer-ts");
  }

  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "mermaid-fixer-ts",
  );
}

function getAppStateDir(): string {
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "mermaid-fixer-ts",
    );
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "mermaid-fixer-ts");
  }

  return join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "mermaid-fixer-ts",
  );
}

export async function loadConfig(path: string): Promise<Config> {
  const defaults = getDefaultConfig();

  try {
    await access(path, constants.F_OK);
  } catch {
    await writeDefaultConfig(path, defaults);
    console.log(`📝 Created default config file: ${path}`);
    return defaults;
  }

  const content = await readFile(path, "utf8");
  const parsed = parseToml(content) as Partial<Config>;

  const config: Config = {
    language: parsed.language ?? defaults.language,
    llm: { ...defaults.llm, ...(parsed.llm ?? {}) },
    mermaid: { ...defaults.mermaid, ...(parsed.mermaid ?? {}) },
    scan: { ...defaults.scan, ...(parsed.scan ?? {}) },
    report: { ...defaults.report, ...(parsed.report ?? {}) },
  };

  // Environment variable overrides for API key
  if (!config.llm.api_key) {
    config.llm.api_key = process.env.MERMAID_FIXER_LLM_API_KEY ??
      process.env.LLM_API_KEY;
  }

  return config;
}

export async function writeDefaultConfig(
  path: string,
  config = getDefaultConfig(),
): Promise<void> {
  const dir = dirname(path);
  if (dir) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path, buildDefaultToml(config), "utf8");
}

function buildDefaultToml(c: Config): string {
  return `# mermaid-fixer configuration
# Language for CLI output: "en" or "zh"
language = "${c.language}"

[llm]
# Provider: ollama, openai, mistral, deepseek, or any OpenAI-compatible endpoint
provider = "${c.llm.provider}"
model    = "${c.llm.model}"
# api_key = "your-key"   # or set MERMAID_FIXER_LLM_API_KEY env var (not needed for ollama)
# base_url = ""          # defaults: ollama=http://localhost:11434/v1  openai=https://api.openai.com/v1
max_tokens  = ${c.llm.max_tokens}
temperature = ${c.llm.temperature}

[mermaid]
timeout_seconds = ${c.mermaid.timeout_seconds}
max_retries     = ${c.mermaid.max_retries}

[scan]
# Regex patterns for file names to skip.
# "._*" (SMB metadata files) is always excluded automatically — no need to add it.
# exclude_patterns = ["\\.tmp$", "^~\\$"]
exclude_patterns = []

[report]
# Optional JSON diagnostics report path.
# Leave empty to write to the OS app-state directory, e.g.
# macOS:  ~/Library/Application Support/mermaid-fixer-ts/reports/
# Linux:  ~/.local/state/mermaid-fixer-ts/reports/
# Win:    %LOCALAPPDATA%\\mermaid-fixer-ts\\reports\\
path = ""
`;
}
