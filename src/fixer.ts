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
  private readonly syntaxGuidePromise: Promise<string>;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(config: Config) {
    this.syntaxGuidePromise = loadSyntaxGuide();
    this.baseUrl = getEffectiveBaseUrl(config.llm);
    this.apiKey = config.llm.api_key ?? "";
    this.model = config.llm.model;
    this.maxTokens = config.llm.max_tokens ?? 4096;
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
    const syntaxGuide = await this.syntaxGuidePromise;
    const prompt = buildUserPrompt(code, validationError);

    const body: ChatRequest = {
      model: this.model,
      messages: [
        { role: "system", content: syntaxGuide },
        { role: "user", content: prompt },
      ],
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: false,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
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
    if (!data.choices?.length) {
      throw new Error("LLM API returned an empty response.");
    }

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
    const mermaidFence = cleaned.match(
      /`{3,}[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n`{3,}/i,
    );
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
      const fenced = out.match(
        /^`{3,}[ \t]*(?:mermaid)?[^\n]*\n([\s\S]*?)\n`{3,}[ \t]*$/i,
      );
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

async function loadSyntaxGuide(): Promise<string> {
  for (const path of ["mermaid-syntax.md", "./mermaid-syntax.md"]) {
    try {
      const text = await Deno.readTextFile(path);
      const trimmed = text.trim();
      if (trimmed) return trimmed;
    } catch {
      // Fall through to the embedded fallback.
    }
  }

  return FALLBACK_SYSTEM_PROMPT;
}

function buildUserPrompt(code: string, validationError?: string): string {
  const diagramType = detectDiagramType(code);
  const errorText = validationError?.trim() || "unknown syntax error";

  return `\
Fix this Mermaid diagram so Mermaid can parse it.

Context:
- Diagram type: ${diagramType}
- Validation/parser error: ${errorText}

Requirements:
1. Return only one fenced Mermaid block.
2. Keep edits minimal. Preserve IDs, labels, and intent unless syntax requires a change.
3. Keep the diagram type declaration on line 1 only.
4. For flowchart edge labels, use official pipe syntax: A -->|label| B.
5. If labels contain punctuation or reserved words, quote the label text safely.
6. Do not include explanations, JSON, or prose outside the code fence.

Broken Mermaid code:
\`\`\`mermaid
${code.trim()}
\`\`\``;
}

function detectDiagramType(code: string): string {
  const firstLine = code.trim().split("\n", 1)[0]?.trim();
  if (!firstLine) return "unknown";
  return firstLine.split(/\s+/)[0];
}

const FALLBACK_SYSTEM_PROMPT = `\
You are a Mermaid diagram syntax fixer.

Rules:
1. Output only a single \`\`\`mermaid fenced block.
2. Preserve business meaning and change only what syntax requires.
3. The first line must be the Mermaid diagram declaration.
4. For flowcharts, edge labels use pipe syntax like A -->|label| B.
5. Quote unsafe label text when needed.
6. Avoid bare reserved words like end as node IDs or labels.
7. Never include explanations outside the fence.`;
