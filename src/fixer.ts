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
        `Set it via --llm-api-key, the config file, or the LLM_API_KEY env var.`,
      );
    }
  }

  /** Send the broken Mermaid code to the LLM and return the fixed version. */
  async fixMermaid(code: string, validationError?: string): Promise<string> {
    const prompt = PROMPT_TEMPLATE
      .replace("{{VALIDATION_ERROR}}", validationError?.trim() || "unknown syntax error")
      .replace("{{MERMAID_CODE}}", code.trim());

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

  /**
   * Strip <think>...</think> blocks emitted by reasoning/thinking models
   * (e.g. Qwen3, DeepSeek-R1).  Must run before any code extraction.
   */
  private stripThinkingBlocks(s: string): string {
    return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  }

  private extractCode(raw: string): string {
    // 1. Remove thinking-model reasoning traces
    const cleaned = this.stripThinkingBlocks(raw);

    // 2. Primary: extract the first ```mermaid … ``` block
    const mermaidFence = cleaned.match(/`{3,}[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n`{3,}/i);
    if (mermaidFence) {
      return this.normalizeMermaid(mermaidFence[1]);
    }

    // 3. Fallback: some models wrap in ```json or plain ```.  Try JSON parse.
    const jsonStripped = this.stripJsonFence(cleaned);
    try {
      const parsed = JSON.parse(jsonStripped) as { fixed_code?: string };
      if (parsed.fixed_code) {
        return this.normalizeMermaid(parsed.fixed_code);
      }
    } catch { /* not JSON */ }

    // 4. Last resort: treat entire response as mermaid code
    return this.normalizeMermaid(cleaned);
  }

  private stripJsonFence(s: string): string {
    const t = s.trim();
    if ((t.startsWith("```json") || t.startsWith("```")) && t.endsWith("```")) {
      return t.split("\n").slice(1, -1).join("\n");
    }
    return t;
  }

  /**
   * Clean common LLM output artifacts from mermaid code:
   * - Unwrap nested markdown fences (``` / ```mermaid)
   * - Normalize line endings
   * - Repair missing newline after declaration ("graph TDNodeA → graph TD\nNodeA")
   */
  private normalizeMermaid(s: string): string {
    let out = s.trim().replace(/\r\n/g, "\n");

    // Unwrap nested fences (some models add them inside fixed_code)
    for (let i = 0; i < 5; i++) {
      const fenced = out.match(/^`{3,}[ \t]*(?:mermaid)?[^\n]*\n([\s\S]*?)\n`{3,}[ \t]*$/i);
      if (!fenced) break;
      out = fenced[1].trim();
    }

    // Fix "graph TDClient Browser ..." — missing newline after declaration
    out = out.replace(
      /^((?:graph|flowchart)\s+(?:TB|TD|BT|RL|LR))(?=\S)/im,
      "$1\n",
    );

    return out.trim();
  }
}

// ── Prompt template (embedded so `deno compile` works without external files) ──

const PROMPT_TEMPLATE = `\
You are a Mermaid diagram syntax fixer. Fix the broken Mermaid code below.

VALIDATION ERROR:
{{VALIDATION_ERROR}}

BROKEN MERMAID CODE:
\`\`\`mermaid
{{MERMAID_CODE}}
\`\`\`

FIXING RULES:
1. Return ONLY the fixed Mermaid code inside a single fenced block — no explanation, no JSON.
2. The opening fence MUST start at column 0 with no indentation:  \`\`\`mermaid
3. The closing fence MUST start at column 0 with no indentation:  \`\`\`
4. Keep edits minimal — only change what is broken. Preserve all node IDs, labels, and business logic.
5. The diagram type declaration must be alone on line 1 (e.g. "graph TD" alone, then a newline).
6. Quote arrow labels that contain spaces or special characters: A -- "label here" --> B
7. For sequenceDiagram: participant declarations and each message arrow must each be on their own line.
8. For classDiagram: class members must be indented inside the class block.
9. For gantt: each section and task must be on its own line with correct date format.
10. For erDiagram: relationship lines follow the pattern: ENTITY1 }|--|| ENTITY2 : "label"
11. Common fixes:
    - Missing arrow type: use --> (solid), --- (dotted), ==> (thick)
    - Unquoted special chars in node labels: wrap in double quotes or ["label"]
    - Subgraph syntax: subgraph Title\\n  nodes\\nend
    - Do not use reserved words (end, graph, etc.) as unquoted node IDs
12. If the code you receive starts with a line like \`\`\`mermaid or \`\`\` (a fence line),
    that line is NOT part of the diagram — ignore it and use only the actual diagram content
    that follows. Never include fence lines inside your output block.

REQUIRED OUTPUT FORMAT (exactly this, nothing else before or after):
\`\`\`mermaid
<fixed mermaid code here>
\`\`\``;

