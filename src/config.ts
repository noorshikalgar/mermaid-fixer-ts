import { parse as parseToml } from "@std/toml";
import { exists } from "@std/fs";

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

export interface Config {
  language: string;
  llm: LlmConfig;
  mermaid: MermaidConfig;
  scan: ScanConfig;
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
  };
}

/** Returns the base URL to use for the LLM API, applying per-provider defaults. */
export function getEffectiveBaseUrl(llm: LlmConfig): string {
  if (llm.base_url) return llm.base_url;
  switch (llm.provider.toLowerCase()) {
    case "ollama":   return "http://localhost:11434/v1";
    case "openai":   return "https://api.openai.com/v1";
    case "deepseek": return "https://api.deepseek.com/v1";
    case "mistral":  return "https://api.mistral.ai/v1";
    default:         return "http://localhost:11434/v1";
  }
}

/** Local providers (Ollama) don't need an API key. */
export function requiresApiKey(provider: string): boolean {
  return !["ollama"].includes(provider.toLowerCase());
}

export async function loadConfig(path: string): Promise<Config> {
  const defaults = getDefaultConfig();

  if (!await exists(path)) {
    await Deno.writeTextFile(path, buildDefaultToml(defaults));
    console.log(`📝 Created default config file: ${path}`);
    return defaults;
  }

  const content = await Deno.readTextFile(path);
  const parsed = parseToml(content) as Partial<Config>;

  const config: Config = {
    language:  parsed.language          ?? defaults.language,
    llm:       { ...defaults.llm,       ...(parsed.llm      ?? {}) },
    mermaid:   { ...defaults.mermaid,   ...(parsed.mermaid  ?? {}) },
    scan:      { ...defaults.scan,      ...(parsed.scan     ?? {}) },
  };

  // Environment variable overrides for API key
  if (!config.llm.api_key) {
    config.llm.api_key =
      Deno.env.get("LITHO_LLM_API_KEY") ??
      Deno.env.get("LLM_API_KEY");
  }

  return config;
}

function buildDefaultToml(c: Config): string {
  return `# mermaid-fixer configuration
# Language for CLI output: "en" or "zh"
language = "${c.language}"

[llm]
# Provider: ollama, openai, mistral, deepseek, or any OpenAI-compatible endpoint
provider = "${c.llm.provider}"
model    = "${c.llm.model}"
# api_key = "your-key"   # or set LITHO_LLM_API_KEY env var (not needed for ollama)
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
`;
}
