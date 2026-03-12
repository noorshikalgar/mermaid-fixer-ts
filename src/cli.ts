import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { getDefaultConfigPath, loadConfig, writeDefaultConfig } from "./config.js";
import { MermaidProcessor } from "./processor.js";
import type { ProcessStats } from "./processor.js";
import { printStatistics } from "./utils.js";
import type { Reporter } from "./reporter.js";

const VERSION = "2.0.0";

const HELP = `
mermaid-fixer v${VERSION}
Scans Markdown files and automatically fixes Mermaid diagram syntax errors using AI.

USAGE:
  mermaid-fixer -d <DIR> [OPTIONS]

OPTIONS:
  -d, --directory  <DIR>      Directory to scan (required)
  -c, --config     <FILE>     Config file path
                             [default: OS config directory]
      --init-config           Write the default config file and exit
      --dry-run               Detect issues only — do not modify files
      --plain-ui              Disable Ink full-screen UI and use plain console output
  -v, --verbose               Show per-file / per-block detail
      --lang       <LANG>     Output language: en (default) or zh
      --report     <FILE>     JSON diagnostics report path
                             [default: OS app-state reports directory]

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
`.trim();

interface CliOptions {
  allowTui: boolean;
  launchTui?: (
    directory: string,
    model: string,
    run: (reporter?: Reporter) => Promise<ProcessStats>,
  ) => Promise<ProcessStats>;
}

export async function runCli({ allowTui, launchTui }: CliOptions): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      directory: { type: "string", short: "d" },
      config: { type: "string", short: "c" },
      lang: { type: "string" },
      report: { type: "string" },
      "llm-provider": { type: "string" },
      "llm-model": { type: "string" },
      "llm-api-key": { type: "string" },
      "llm-base-url": { type: "string" },
      "max-tokens": { type: "string" },
      temperature: { type: "string" },
      "init-config": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "plain-ui": { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      exclude: { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values["help"]) {
    console.log(HELP);
    process.exit(0);
  }
  if (values["version"]) {
    console.log(`mermaid-fixer v${VERSION}`);
    process.exit(0);
  }

  const configPath = values["config"] ?? getDefaultConfigPath();
  if (values["init-config"]) {
    await writeDefaultConfig(configPath);
    console.log(`📝 Wrote default config: ${configPath}`);
    process.exit(0);
  }

  const directory = values["directory"];
  if (!directory) {
    console.error("❌ --directory is required.\n");
    console.log(HELP);
    process.exit(1);
  }

  const dryRun = values["dry-run"];
  const plainUi = values["plain-ui"];
  const verbose = values["verbose"];
  const excludePatterns = values["exclude"] ?? [];

  let config = await loadConfig(configPath).catch((err) => {
    console.error(
      `❌ Failed to load config: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  });

  if (values["lang"]) config.language = values["lang"];
  if (values["llm-provider"]) config.llm.provider = values["llm-provider"];
  if (values["llm-model"]) config.llm.model = values["llm-model"];
  if (values["llm-api-key"]) config.llm.api_key = values["llm-api-key"];
  if (values["llm-base-url"]) config.llm.base_url = values["llm-base-url"];
  if (values["max-tokens"]) {
    config.llm.max_tokens = parseInt(values["max-tokens"], 10);
  }
  if (values["temperature"]) {
    config.llm.temperature = parseFloat(values["temperature"]);
  }
  if (values["report"]) config.report.path = values["report"];
  if (excludePatterns.length) {
    config.scan.exclude_patterns = [
      ...(config.scan.exclude_patterns ?? []),
      ...excludePatterns,
    ];
  }

  try {
    const resolvedDirectory = resolve(directory);
    const runProcessor = async (reporter?: Reporter) => {
      const processor = new MermaidProcessor(config, dryRun, verbose, reporter);
      return processor.processDirectory(resolvedDirectory, dryRun);
    };

    if (allowTui && launchTui && process.stdout.isTTY && !plainUi) {
      const stats = await launchTui(resolvedDirectory, config.llm.model, runProcessor);
      printStatistics(stats, dryRun);
      return;
    }

    const stats = await runProcessor();
    printStatistics(stats, dryRun);
  } catch (err) {
    console.error(
      `❌ Processing failed: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}
