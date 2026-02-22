import { parseArgs } from "@std/cli";
import { resolve } from "@std/path";
import { loadConfig } from "./config.ts";
import { MermaidProcessor } from "./processor.ts";
import { printStatistics } from "./utils.ts";

const VERSION = "1.0.0";

const HELP = `
mermaid-fixer v${VERSION}
Scans Markdown files and automatically fixes Mermaid diagram syntax errors using AI.

USAGE:
  mermaid-fixer -d <DIR> [OPTIONS]

OPTIONS:
  -d, --directory  <DIR>      Directory to scan (required)
  -c, --config     <FILE>     Config file path  [default: config.toml]
      --dry-run               Detect issues only — do not modify files
  -v, --verbose               Show per-file / per-block detail
      --lang       <LANG>     Output language: en (default) or zh

  LLM options (override config file):
      --llm-provider  <NAME>  Provider: ollama, openai, mistral, deepseek
      --llm-model     <NAME>  Model name  (e.g. llama3, gpt-4o, mistral-small)
      --llm-api-key   <KEY>   API key  (not required for ollama)
      --llm-base-url  <URL>   Custom API base URL
      --max-tokens    <N>     Max tokens  [default: 4096]
      --temperature   <F>     Temperature 0.0–1.0  [default: 0.1]

  File filtering:
      --exclude  <PATTERN>    Regex to skip files by name (repeatable).
                              "._*" (SMB metadata) is always skipped automatically.

  -h, --help                  Show this help
      --version               Show version

EXAMPLES:
  # Dry-run: scan only, no changes
  mermaid-fixer -d ./docs --dry-run -v

  # Fix with local Ollama (no API key needed)
  mermaid-fixer -d ./docs --llm-provider ollama --llm-model llama3

  # Fix with OpenAI
  mermaid-fixer -d ./docs --llm-provider openai --llm-model gpt-4o --llm-api-key sk-...

  # Fix with Mistral
  mermaid-fixer -d ./docs --llm-provider mistral --llm-model mistral-small-latest --llm-api-key <key>

  # Use a config file
  mermaid-fixer -d ./docs -c /path/to/config.toml

  # Skip temp files in addition to the automatic SMB exclusion
  mermaid-fixer -d ./docs --exclude "\\.tmp$" --exclude "^~\\$"
`.trim();

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: [
      "directory", "d",
      "config", "c",
      "lang",
      "llm-provider", "llm-model", "llm-api-key", "llm-base-url",
      "max-tokens", "temperature",
    ],
    boolean: ["dry-run", "verbose", "v", "help", "h", "version"],
    collect: ["exclude"],
    alias: { d: "directory", c: "config", v: "verbose", h: "help" },
  });

  if (args["help"] || args["h"]) { console.log(HELP); Deno.exit(0); }
  if (args["version"])            { console.log(`mermaid-fixer v${VERSION}`); Deno.exit(0); }

  const directory = (args["directory"] ?? args["d"]) as string | undefined;
  if (!directory) {
    console.error("❌ --directory is required.\n");
    console.log(HELP);
    Deno.exit(1);
  }

  const configPath     = (args["config"] ?? args["c"] ?? "config.toml") as string;
  const dryRun: boolean = !!args["dry-run"];
  const verbose: boolean = !!(args["verbose"] ?? args["v"]);
  const excludePatterns = (args["exclude"] ?? []) as string[];

  // ── Load & merge config ──────────────────────────────────────────────────
  let config = await loadConfig(configPath).catch((err) => {
    console.error(`❌ Failed to load config: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  });

  if (args["lang"])           config.language         = args["lang"] as string;
  if (args["llm-provider"])   config.llm.provider     = args["llm-provider"] as string;
  if (args["llm-model"])      config.llm.model        = args["llm-model"] as string;
  if (args["llm-api-key"])    config.llm.api_key      = args["llm-api-key"] as string;
  if (args["llm-base-url"])   config.llm.base_url     = args["llm-base-url"] as string;
  if (args["max-tokens"])     config.llm.max_tokens   = parseInt(args["max-tokens"] as string, 10);
  if (args["temperature"])    config.llm.temperature  = parseFloat(args["temperature"] as string);
  if (excludePatterns.length) {
    config.scan.exclude_patterns = [...(config.scan.exclude_patterns ?? []), ...excludePatterns];
  }

  // ── Run ──────────────────────────────────────────────────────────────────
  let processor: MermaidProcessor;
  try {
    processor = new MermaidProcessor(config, dryRun, verbose);
  } catch (err) {
    console.error(`❌ Initialization failed: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }

  try {
    const stats = await processor.processDirectory(resolve(directory), dryRun);
    printStatistics(stats, dryRun);
  } catch (err) {
    console.error(`❌ Processing failed: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }
}

main();
