# mermaid-fixer-ts

A TypeScript (Deno) port of [mermaid-fixer](https://github.com/sopaco/mermaid-fixer) — an AI-driven tool that automatically detects and fixes syntax errors in Mermaid diagrams inside Markdown files.

---

## ✨ What it does

`mermaid-fixer-ts` scans a directory for Markdown files, extracts every Mermaid code block, and uses a large language model (LLM) to repair any diagrams that have invalid syntax — all without changing anything else in your files.

### Six-stage pipeline

| # | Stage | Description |
|---|-------|-------------|
| 1 | **Scan** | Recursively discover `.md` / `.markdown` files |
| 2 | **Extract** | Pull out every ` ```mermaid ` code block |
| 3 | **Validate** | Check each block for syntax errors |
| 4 | **Fix** | Ask an LLM to repair broken diagrams |
| 5 | **Re-validate** | Confirm the fix is actually valid |
| 6 | **Save** | Write corrected diagrams back to disk |

---

## 🚀 Getting Started

### Prerequisites

- [Deno](https://deno.land/) v2 or later
- An LLM provider (Ollama running locally, or an API key for OpenAI / Mistral / DeepSeek)

### Run directly

```bash
deno task run -- -d ./docs
```

### Build a native binary

```bash
# Current platform
deno task build

# macOS ARM
deno task build:mac-arm

# macOS x64
deno task build:mac-x64

# Linux x64
deno task build:linux

# Windows x64
deno task build:windows
```

Binaries are placed in `dist/`.

---

## ⚙️ Configuration

A `config.toml` is auto-generated on first run. Edit it to set your LLM provider:

```toml
language = "en"   # or "zh"

[llm]
provider    = "ollama"      # ollama | openai | mistral | deepseek
model       = "llama3"
# api_key   = "your-key"   # not required for Ollama
max_tokens  = 4096
temperature = 0.1

[mermaid]
timeout_seconds = 120
max_retries     = 3

[scan]
exclude_patterns = []
```

---

## 🖥️ CLI Reference

```
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
      --llm-model     <NAME>  Model name
      --llm-api-key   <KEY>   API key  (not required for Ollama)
      --llm-base-url  <URL>   Custom API base URL
      --max-tokens    <N>     Max tokens  [default: 4096]
      --temperature   <F>     Temperature 0.0–1.0  [default: 0.1]

  File filtering:
      --exclude  <PATTERN>    Regex to skip files by name (repeatable)

  -h, --help                  Show this help
      --version               Show version
```

### Examples

```bash
# Dry-run: detect issues without touching files
mermaid-fixer-ts -d ./docs --dry-run -v

# Fix using local Ollama (no API key needed)
mermaid-fixer-ts -d ./docs --llm-provider ollama --llm-model llama3

# Fix using OpenAI
mermaid-fixer-ts -d ./docs --llm-provider openai --llm-model gpt-4o --llm-api-key sk-...

# Fix using Mistral
mermaid-fixer-ts -d ./docs --llm-provider mistral --llm-model mistral-small-latest --llm-api-key <key>
```

---

## 🛠️ Built With

- [Deno](https://deno.land/) — secure TypeScript runtime
- [@std/cli](https://jsr.io/@std/cli) — argument parsing
- [@std/path](https://jsr.io/@std/path) — cross-platform path handling
- [@std/fs](https://jsr.io/@std/fs) — filesystem utilities
- [@std/toml](https://jsr.io/@std/toml) — TOML config parsing

---

## 💡 Inspiration & Credits

This project is a TypeScript rewrite inspired by **[sopaco/mermaid-fixer](https://github.com/sopaco/mermaid-fixer)** — the original high-performance, AI-driven Mermaid syntax fixer built with Rust.

> All credit for the original concept, pipeline design, and feature set goes to **[sopaco](https://github.com/sopaco)**.  
> If you find the original project useful, please give it a ⭐ and consider [sponsoring the author](https://github.com/sponsors/sopaco).

---

## 📄 License

MIT
