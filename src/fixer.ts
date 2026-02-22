import { getEffectiveBaseUrl, requiresApiKey } from "./config.ts";
import type { Config } from "./config.ts";

// ── OpenAI-compatible types ────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatRequest {
  model: string;
  messages: Message[];
  max_tokens?: number;
  temperature?: number;
  stream: false;
}

interface ChatResponse {
  choices: Array<{ message: Message }>;
}

// Expected shape of the JSON returned by the LLM (mirrors prompt.tpl)
interface FixResponse {
  fixed_code: string;
  explanation: string;
  changes?: Array<{
    type: string;
    original: string;
    fixed: string;
    reason: string;
  }>;
}

// ── AiFixer ───────────────────────────────────────────────────────────────

export class AiFixer {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(config: Config) {
    this.baseUrl     = getEffectiveBaseUrl(config.llm);
    this.apiKey      = config.llm.api_key ?? "";
    this.model       = config.llm.model;
    this.maxTokens   = config.llm.max_tokens  ?? 4096;
    this.temperature = config.llm.temperature ?? 0.1;

    if (requiresApiKey(config.llm.provider) && !this.apiKey) {
      throw new Error(
        `API key required for provider "${config.llm.provider}". ` +
        `Set it via --llm-api-key, the config file, or the LITHO_LLM_API_KEY env var.`,
      );
    }
  }

  /** Send the broken Mermaid code to the LLM and return the fixed version. */
  async fixMermaid(code: string): Promise<string> {
    const prompt = PROMPT_TEMPLATE.replace("{{MERMAID_CODE}}", code);

    const body: ChatRequest = {
      model:       this.model,
      messages:    [{ role: "user", content: prompt }],
      max_tokens:  this.maxTokens,
      temperature: this.temperature,
      stream:      false,
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM API request failed (HTTP ${res.status}): ${text}`);
    }

    const data = await res.json() as ChatResponse;
    if (!data.choices?.length) throw new Error("LLM API returned an empty response.");

    return this.extractCode(data.choices[0].message.content);
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private extractCode(raw: string): string {
    const cleaned = this.stripJsonFence(raw);

    // 1. Try structured JSON response
    try {
      const parsed = JSON.parse(cleaned) as FixResponse;
      if (parsed.fixed_code) {
        console.log(`         📋 Fix summary: ${parsed.explanation}`);
        parsed.changes?.forEach((c, i) =>
          console.log(`         🔧 Change ${i + 1} [${c.type}]: ${c.reason}`)
        );
        return parsed.fixed_code.trim();
      }
    } catch { /* not JSON */ }

    // 2. Extract ```mermaid … ``` block
    const m = raw.match(/```mermaid\r?\n([\s\S]*?)```/);
    if (m) return m[1].trim();

    // 3. Fallback: return raw trimmed content
    return raw.trim();
  }

  private stripJsonFence(s: string): string {
    const t = s.trim();
    if ((t.startsWith("```json") || t.startsWith("```")) && t.endsWith("```")) {
      return t.split("\n").slice(1, -1).join("\n");
    }
    return t;
  }
}

// ── Prompt template (embedded so `deno compile` works without external files) ──

const PROMPT_TEMPLATE = `## 🎯 Goal

You are a professional **Mermaid diagram syntax checker and repair assistant**.

Analyse the Mermaid code below, identify all syntax errors, and return a **single JSON object** — no other text.

\`\`\`json
{
  "fixed_code": "<complete corrected Mermaid code>",
  "explanation": "<brief summary of issues found and fixes applied>",
  "changes": [
    {
      "type": "syntax_error|node_text|arrow_label|style_declaration|structure",
      "original": "<original erroneous fragment>",
      "fixed": "<corrected fragment>",
      "reason": "<why this was changed>"
    }
  ]
}
\`\`\`

Mermaid code to fix:
\`\`\`mermaid
{{MERMAID_CODE}}
\`\`\`

---

## ✅ Rules (follow strictly)

### 1. Node IDs
- Letters, digits, underscores only; must not start with a digit.

### 2. Node labels (text inside \`[]\`, \`()\`, \`{}\`, etc.)
- Must NOT contain: \`( ) [ ] { } < > : , + = |\`
- Rewrite as a concise English phrase if needed.

### 3. Arrow labels
- Any label with spaces or special characters MUST be double-quoted.
  - ✅  \`A -- "cache miss" --> B\`
  - ❌  \`A -- cache miss --> B\`

### 4. Graph declaration
- Must start with a valid type: \`graph\`, \`flowchart\`, \`sequenceDiagram\`, \`classDiagram\`, etc.

### 5. Arrow syntax
- Use valid Mermaid arrows: \`-->\`, \`---\`, \`-.->\`, \`==>\`, etc.

### 6. Style declarations
- Color values must use: \`fill:#RRGGBB\` format.

### 7. Preserve meaning
- Keep the original business logic and flow intact.

---

Return ONLY the JSON object. Do not add any explanation outside it.`;
