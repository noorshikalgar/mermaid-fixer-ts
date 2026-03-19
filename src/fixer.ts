import { getEffectiveBaseUrl, requiresApiKey } from "./config.js";
import type { Config } from "./config.js";

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

export interface FixAttempt {
  rawResponse: string;
  fixedCode: string;
}

// ── AiFixer ───────────────────────────────────────────────────────────────

export class AiFixer {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(config: Config) {
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
  async fixMermaid(
    code: string,
    validationError?: string,
  ): Promise<FixAttempt> {
    const first = await this.requestCompletion([
      { role: "system", content: MERMAID_FIXER_SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(code, validationError) },
    ]);

    const firstCode = this.extractCode(first);
    const obviousFailure = detectObviousCandidateFailure(firstCode);
    if (!obviousFailure) {
      return {
        rawResponse: first,
        fixedCode: firstCode,
      };
    }

    const second = await this.requestCompletion([
      { role: "system", content: MERMAID_FIXER_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildRetryPrompt(code, validationError, first, firstCode, obviousFailure),
      },
    ]);

    return {
      rawResponse: second,
      fixedCode: this.extractCode(second),
    };
  }

  // ── private helpers ──────────────────────────────────────────────────────

  /**
   * Strip <think>...</think> blocks emitted by reasoning/thinking models
   * (e.g. Qwen3, DeepSeek-R1).  Must run before any code extraction.
   */
  private stripThinkingBlocks(s: string): string {
    return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    retries = 4,
  ): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, init);
        if (!shouldRetryResponse(response) || attempt === retries) {
          return response;
        }
        lastError = new Error(`retryable HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }

      if (attempt === retries) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async requestCompletion(messages: Message[]): Promise<string> {
    const body: ChatRequest = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: false,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const res = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM API request failed (HTTP ${res.status}): ${text}`);
    }

    const data = await res.json() as ChatResponse;
    const rawResponse = data.choices?.[0]?.message?.content;
    if (!rawResponse) {
      throw new Error("LLM API returned an empty response.");
    }

    return rawResponse;
  }

  private extractCode(raw: string): string {
    // 1. Remove thinking-model reasoning traces
    const cleaned = this.stripThinkingBlocks(raw);

    // 2. Primary: extract the first ```mermaid … ``` block
    const mermaidFence = cleaned.match(
      /[ \t]*`{3,}[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*`{3,}/i,
    );
    if (mermaidFence) {
      return this.normalizeMermaid(mermaidFence[1]);
    }

    // 2b. Some models return an opening mermaid fence without a closing fence.
    const looseFence = cleaned.match(/[ \t]*`{3,}[ \t]*mermaid[ \t]*\r?\n([\s\S]*)$/i);
    if (looseFence) {
      return this.normalizeMermaid(looseFence[1]);
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

    // Remove stray mermaid fence lines that still leak through from model output.
    out = out
      .split("\n")
      .filter((line) => !/^[ \t]*`{3,}[ \t]*(?:mermaid)?[ \t]*$/i.test(line))
      .join("\n")
      .trim();

    // Fix "graph TDClient Browser ..." — missing newline after declaration
    out = out.replace(
      /^((?:graph|flowchart)\s+(?:TB|TD|BT|RL|LR))(?=\S)/im,
      "$1\n",
    );

    return sanitizeGeneratedMermaid(out).trim();
  }
}

function sanitizeGeneratedMermaid(input: string): string {
  const lines = input.split("\n");
  const seenIds = new Set<string>();
  const diagramType = detectDiagramType(input);

  for (const line of lines) {
    collectDefinedIds(line, seenIds);
  }

  const sanitized = lines.map((line) =>
    sanitizeMermaidLine(line, seenIds, diagramType)
  );
  return closeOpenSubgraphs(sanitized).join("\n").trim();
}

function sanitizeMermaidLine(
  line: string,
  seenIds: Set<string>,
  diagramType: string,
): string {
  let out = line.replace(/"([A-Za-z][A-Za-z0-9_]*\[[^"\n]+\])"/g, "$1");
  out = out.replace(/^(\s*)SubGraph\b/, "$1subgraph");
  out = out.replace(/^(\s*)End\s*$/, "$1end");
  if (diagramType !== "sequenceDiagram") {
    out = out.replace(/-\.\s*-->\s*\|/g, "-.->|");
    out = out.replace(/-\.\s*-->(?!\|)/g, "-.->");
    out = out.replace(/-\.\s*->\|/g, "-.->|");
    out = out.replace(/-\.\s*->(?![>\|])/g, "-.->");
    out = out.replace(/==\s+([A-Za-z][A-Za-z0-9_]*(?:\[[^\]\n]+\]|\([^)]+\)|\{[^}\n]+\})?)/g, "==> $1");
    out = out.replace(/(?<![-.])->\|/g, "-->|");
    out = out.replace(/\s->\s/g, " --> ");
  }
  out = out.replace(/--\|>/g, "-->");
  out = out.replace(/--\|/g, "-->|");
  out = out.replace(/\|[^|\n]*\|\|([^|\n]+)\|/g, "|$1|");

  if (/^\s*subgraph\b/i.test(out)) {
    return sanitizeSubgraphLine(out, seenIds);
  }

  out = sanitizeFlowNoteLine(out, seenIds);
  out = sanitizeInlineActionChain(out);
  out = sanitizeInlineColonEdge(out);
  out = sanitizeDanglingLabeledEdge(out, seenIds);
  out = sanitizeQuotedEdgeText(out);
  out = sanitizeQuotedAliasLine(out, seenIds);
  out = sanitizeSequenceTargetLabel(out);
  out = sanitizeBareDoubleDash(out);
  out = sanitizeMultiTargetEdge(out);
  out = sanitizeTrailingNodeDeclaration(out);
  out = sanitizeArrowTargetWithPseudoLabel(out, seenIds);
  out = sanitizeStyleLine(out, seenIds);
  out = sanitizeAllEdgeLabels(out);
  out = sanitizeNodeLabels(out);

  return out;
}

function sanitizeSubgraphLine(line: string, seenIds: Set<string>): string {
  const match = line.match(/^(\s*)subgraph\s+(.+)$/i);
  if (!match) return line;

  const indent = match[1];
  const rawBody = match[2].trim();

  if (/^[A-Za-z][A-Za-z0-9_]*\s*\[".*"\]\s*$/u.test(rawBody)) {
    const explicit = rawBody.match(/^([A-Za-z][A-Za-z0-9_]*)/u);
    if (explicit) seenIds.add(explicit[1]);
    return line;
  }

  if (/^[A-Za-z][A-Za-z0-9_]*$/u.test(rawBody)) {
    seenIds.add(rawBody);
    return line;
  }

  const label = sanitizeLabelText(rawBody, { maxWords: 6 }) || "Group";
  const id = toSafeId(rawBody, "Group");
  seenIds.add(id);
  return `${indent}subgraph ${id}["${label}"]`;
}

function sanitizeArrowTargetWithPseudoLabel(
  line: string,
  seenIds: Set<string>,
): string {
  const match = line.match(
    /^(\s*[A-Za-z][A-Za-z0-9_]*\s*(?:-->|-.->|==>)\s*(?:\|[^|]*\|\s*)?)([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/u,
  );
  if (!match) return line;

  const prefix = match[1];
  const rawId = match[2];
  const rawLabel = match[3];
  const id = toSafeId(rawId, "Step");
  const label = sanitizeLabelText(rawLabel, { maxWords: 8 }) || id;
  seenIds.add(id);
  return `${prefix}${id}[${label}]`;
}

function sanitizeStyleLine(line: string, seenIds: Set<string>): string {
  const match = line.match(/^(\s*style\s+)([A-Za-z][A-Za-z0-9_-]*)(\s+.+)$/u);
  if (!match) return line;

  const prefix = match[1];
  const rawId = match[2];
  const suffix = match[3];
  const safeId = toSafeId(rawId, rawId);

  if (seenIds.has(rawId)) return line;
  if (seenIds.has(safeId)) return `${prefix}${safeId}${suffix}`;

  const compact = rawId.replace(/[^A-Za-z0-9]/g, "");
  if (compact.length === 1 && seenIds.has(compact)) {
    return `${prefix}${compact}${suffix}`;
  }

  const firstLetter = compact.charAt(0);
  if (firstLetter && seenIds.has(firstLetter)) {
    return `${prefix}${firstLetter}${suffix}`;
  }

  return `${prefix}${safeId}${suffix}`;
}

function sanitizeQuotedAliasLine(line: string, seenIds: Set<string>): string {
  const match = line.match(
    /^(\s*[A-Za-z][A-Za-z0-9_]*(?:\s*[\-\.=]+>\s*|\s*---\s*))"([^"\n]+)"\s+as\s+([A-Za-z][A-Za-z0-9_]*)\s*$/u,
  );
  if (!match) return line;

  const prefix = match[1];
  const label = sanitizeLabelText(match[2], { maxWords: 8 }) || "Step";
  const id = match[3];
  seenIds.add(id);
  return `${prefix}${id}[${label}]`;
}

function sanitizeQuotedEdgeText(line: string): string {
  const match = line.match(
    /^(\s*[A-Za-z][A-Za-z0-9_]*(?:\[[^\]\n]+\]|\([^)]+\))?\s*(?:-->|-.->|==>)\s*)"([^"\n]+)"\s+([A-Za-z][A-Za-z0-9_]*(?:\[[^\]\n]+\]|\([^)]+\))?)\s*$/u,
  );
  if (!match) return line;

  const prefix = match[1];
  const label = sanitizeLabelText(match[2], { maxWords: 4 }) || "Flow";
  const target = match[3];
  return `${prefix}|${label}| ${target}`;
}

function sanitizeSequenceTargetLabel(line: string): string {
  const match = line.match(
    /^(\s*[A-Za-z][A-Za-z0-9_]*\s*(?:->>|-->>|->|-->|-x|--x)\s+)([A-Za-z][A-Za-z0-9_]*)\[([^\]\n]+)\]\s*$/u,
  );
  if (!match) return line;

  const prefix = match[1];
  const target = match[2];
  const message = sanitizeLabelText(match[3], { maxWords: 10 }) || "Message";
  return `${prefix}${target}: ${message}`;
}

function sanitizeFlowNoteLine(line: string, seenIds: Set<string>): string {
  const match = line.match(
    /^(\s*)Note\s+(?:left|right|top|bottom)\s+of\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.+)$/iu,
  );
  if (!match) return line;

  const indent = match[1];
  const anchor = match[2];
  const label = sanitizeLabelText(match[3], { maxWords: 8 }) || "Note";
  const noteId = `${anchor}_Note`;
  seenIds.add(noteId);
  return `${indent}${anchor} --> ${noteId}[${label}]`;
}

function sanitizeBareDoubleDash(line: string): string {
  return line.replace(
    /\b([A-Za-z][A-Za-z0-9_]*)\s+--\s+([A-Za-z][A-Za-z0-9_]*(?:\[[^\]\n]+\])?)/g,
    "$1 --> $2",
  );
}

function sanitizeInlineActionChain(line: string): string {
  const tripleArrow = line.split(/\s+-->\s+/u);
  if (tripleArrow.length === 3) {
    const [source, rawLabel, target] = tripleArrow;
    if (!rawLabel.includes("[") && !rawLabel.includes("{")) {
      const label = sanitizeLabelText(rawLabel, { maxWords: 4 }) || "Flow";
      return `${source} -->|${label}| ${target}`;
    }
  }

  const dashedMatch = line.match(/^(\s*.+?)\s+--\s+(.+?)\s+-->\s+(.+?)\s*$/u);
  if (!dashedMatch) return line;

  const source = dashedMatch[1].trimEnd();
  const rawLabel = dashedMatch[2].trim();
  const target = dashedMatch[3].trim();
  if (!rawLabel || rawLabel.includes("[") || rawLabel.includes("{")) return line;

  const label = sanitizeLabelText(rawLabel, { maxWords: 4 }) || "Flow";
  return `${source} -->|${label}| ${target}`;
}

function sanitizeInlineColonEdge(line: string): string {
  const match = line.match(
    /^(\s*[A-Za-z][A-Za-z0-9_]*\s*-->\s*)([A-Za-z][A-Za-z0-9_]*)(?:\s*:\s*|\s+\|)(.+?)(?:\|\s*)?$/u,
  );
  if (!match) return line;

  const source = match[1];
  const target = match[2];
  const label = sanitizeLabelText(match[3], { maxWords: 4 }) || "Flow";
  return `${source}|${label}| ${target}`;
}

function sanitizeDanglingLabeledEdge(line: string, seenIds: Set<string>): string {
  const match = line.match(
    /^(\s*[A-Za-z][A-Za-z0-9_]*\s*)(-.->|-->|==>)(\|[^|\n]+\|)\s*$/u,
  );
  if (!match) return line;

  const source = match[1].trim();
  const arrow = match[2];
  const rawLabel = match[3].slice(1, -1);
  const label = sanitizeLabelText(rawLabel, { maxWords: 5 }) || "Result";
  const id = toSafeId(label, "Result");
  seenIds.add(id);
  return `${source} ${arrow}${match[3]} ${id}[${label}]`;
}

function closeOpenSubgraphs(lines: string[]): string[] {
  let depth = 0;

  for (const line of lines) {
    if (/^\s*subgraph\b/i.test(line)) depth++;
    else if (/^\s*end\s*$/i.test(line)) depth = Math.max(0, depth - 1);
  }

  if (depth === 0) return lines;
  return [...lines, ...Array.from({ length: depth }, () => "end")];
}

function sanitizeMultiTargetEdge(line: string): string {
  const match = line.match(
    /^(\s*[A-Za-z][A-Za-z0-9_]*\s*(?:-->|-.->|==>)\s*(?:\|[^|]*\|\s*)?)([A-Za-z][A-Za-z0-9_]*(?:\s+[A-Za-z][A-Za-z0-9_]*){1,})\s*$/u,
  );
  if (!match) return line;

  const prefix = match[1];
  const targets = match[2].trim().split(/\s+/);
  if (targets.length < 2) return line;
  return targets.map((target) => `${prefix}${target}`).join("\n");
}

function sanitizeTrailingNodeDeclaration(line: string): string {
  const match = line.match(
    /^(\s*[A-Za-z][A-Za-z0-9_]*\s*(?:-->|-.->|==>)\s*(?:\|[^|]*\|\s*)?[A-Za-z][A-Za-z0-9_]*)(\s+)([A-Za-z][A-Za-z0-9_]*(?:\[[^\]\n]+\]|\([^)]+\)|\{[^}\n]+\}))\s*$/u,
  );
  if (!match) return line;

  return `${match[1]}\n${match[3]}`;
}

function sanitizeAllEdgeLabels(line: string): string {
  return line.replace(/\|([^|\n]+)\|/g, (_match, label: string) => {
    const sanitized = sanitizeLabelText(label, { maxWords: 4 }) || "Flow";
    return `|${sanitized}|`;
  });
}

function sanitizeNodeLabels(line: string): string {
  let out = "";

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char !== "[" && char !== "{") {
      out += char;
      continue;
    }

    const close = char === "[" ? "]" : "}";
    let depth = 1;
    let j = i + 1;

    while (j < line.length && depth > 0) {
      if (line[j] === char) depth++;
      else if (line[j] === close) depth--;
      j++;
    }

    if (depth !== 0) {
      out += char;
      continue;
    }

    const inner = line.slice(i + 1, j - 1);
    const sanitized = sanitizeLabelText(inner, { maxWords: 10 }) || "Step";
    out += `${char}${sanitized}${close}`;
    i = j - 1;
  }

  return out;
}

function detectObviousCandidateFailure(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) return "candidate was empty";
  if (/^(?:graph|flowchart)\s*\{\s*\}\s*$/i.test(trimmed)) {
    return "candidate was an empty graph placeholder";
  }

  const lines = trimmed.split("\n");
  if (lines.length <= 1) {
    return "candidate had only a diagram declaration";
  }

  const nonCommentBody = lines.slice(1).filter((line) => {
    const value = line.trim();
    return value.length > 0 && !value.startsWith("%%");
  });
  if (nonCommentBody.length === 0) {
    return "candidate had no diagram body";
  }

  return null;
}

function shouldRetryResponse(response: Response): boolean {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(response.status);
}

function collectDefinedIds(line: string, seenIds: Set<string>): void {
  const subgraph = line.match(/^\s*subgraph\s+([A-Za-z][A-Za-z0-9_]*)/u);
  if (subgraph) {
    seenIds.add(subgraph[1]);
  }

  for (const match of line.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*[\[{]/gu)) {
    seenIds.add(match[1]);
  }
}

function sanitizeLabelText(
  text: string,
  options: { maxWords?: number } = {},
): string {
  let out = text;

  out = out.replace(/\\"/g, " ");
  out = out.replace(/["'`]/g, " ");
  out = out.replace(/<+/g, " less than ");
  out = out.replace(/>+/g, " greater than ");
  out = out.replace(/[()[\]{}]/g, " ");
  out = out.replace(/[=:;,/\\]/g, " ");
  out = out.replace(/[?]/g, " ");
  out = out.replace(/&/g, " and ");
  out = out.replace(/\b(?:e\.g\.|i\.e\.)\b/gi, " ");
  out = out.replace(/[_-]+/g, " ");
  out = out.replace(/\s+/g, " ").trim();

  if (options.maxWords && out) {
    const words = out.split(" ");
    if (words.length > options.maxWords) {
      out = words.slice(0, options.maxWords).join(" ");
    }
  }

  return out;
}

function toSafeId(text: string, fallback: string): string {
  const words = sanitizeLabelText(text)
    .split(" ")
    .filter(Boolean);
  const combined = words.join("_").replace(/[^A-Za-z0-9_]/g, "");
  const candidate = combined || fallback;
  return /^[A-Za-z]/.test(candidate) ? candidate : `${fallback}_${candidate}`;
}

function buildUserPrompt(code: string, validationError?: string): string {
  const diagramType = detectDiagramType(code);
  const errorText = validationError?.trim() || "unknown syntax error";

  return `\
Fix this Mermaid diagram so Mermaid can parse it cleanly.

Context:
- Diagram type: ${diagramType}
- Validation/parser error: ${errorText}

Requirements:
1. Return only one fenced Mermaid block.
2. Keep edits minimal. Preserve IDs, labels, and intent unless syntax requires a change.
3. Keep the diagram type declaration on line 1 only.
4. Follow the Mermaid validation rules from the system prompt exactly.
5. The result must be valid Mermaid, not just similar-looking text.
6. Do not include explanations, JSON, or prose outside the code fence.
7. If a node label contains embedded quotes like \`\"...\\"\`, rewrite the label into plain text instead of escaping quotes.
8. If a node label contains array literals, JSON-like text, quoted lists, or bracket-heavy examples, rewrite it into plain words instead of preserving the literal symbols.
9. If a subgraph title has spaces or punctuation, use safe subgraph syntax with an ID and a plain readable label.
10. Every node reference in an edge must be a valid Mermaid node ID or \`ID[Label]\`. Never invent pseudo-syntax like \`Node_Name: text\`.
11. Keep edge labels extremely short and plain. Remove quotes, parentheses, code syntax, and detailed infrastructure text from edges.
12. If an edge label needs explanation, move that meaning into an intermediate node.
13. If a node label looks like code, config, JSON, an array, or a function call, rewrite it as short human text.
14. If a \`style\` line appears, the styled ID must exactly match a real node or subgraph ID.
15. Never return Mermaid fences inside the diagram body. The fence should wrap the diagram once, at the outermost level only.
16. Never use invalid dotted arrows like \`-.-->\` or \`-.-->|Label|\`. The valid dotted flowchart arrow is \`-.->\` or \`-.->|Label|\`.
17. Do not return placeholder output like \`graph {}\`, \`flowchart {}\`, or a diagram declaration with no body.

Expected output format:
\`\`\`mermaid
<fixed mermaid only>
\`\`\`

Do not return:
- JSON
- markdown commentary
- bullet points
- multiple code blocks
- text before or after the Mermaid fence
- indented or nested code fences inside the Mermaid output

Broken Mermaid code:
\`\`\`mermaid
${code.trim()}
\`\`\``;
}

function buildRetryPrompt(
  originalCode: string,
  validationError: string | undefined,
  previousResponse: string,
  previousCandidate: string,
  retryReason: string,
): string {
  return `\
Your previous Mermaid fix was not usable.

Why it failed:
- ${retryReason}
- Original validator/parser error: ${validationError?.trim() || "unknown syntax error"}

Fix the ORIGINAL diagram again from scratch.
Do not summarize.
Do not return a placeholder.
Do not return \`graph {}\`.
Do not return only the header line.
Do not use invalid dotted arrows like \`-.-->\`.
Return exactly one fenced Mermaid block.

Previous raw response:
\`\`\`
${previousResponse.trim()}
\`\`\`

Previous extracted Mermaid candidate:
\`\`\`mermaid
${previousCandidate.trim()}
\`\`\`

Original broken Mermaid:
\`\`\`mermaid
${originalCode.trim()}
\`\`\``;
}

function detectDiagramType(code: string): string {
  const firstLine = code.trim().split("\n", 1)[0]?.trim();
  if (!firstLine) return "unknown";
  return firstLine.split(/\s+/)[0];
}

const MERMAID_AGENT_VALIDATION_BLOCK = `**MERMAID DIAGRAM VALIDATION (if using diagrams):**
Treat Mermaid as strict syntax. If unsure, simplify the diagram.

**Output Rules:**
1. Emit Mermaid only inside fenced block:
   \`\`\`mermaid
   <diagram>
   \`\`\`
2. Do not output partial/broken Mermaid.
3. If Mermaid is risky, skip Mermaid instead of emitting invalid syntax.
4. If a valid diagram would still look cluttered or unreadable, simplify it before output.

**Allowed Diagram Starters (must be first Mermaid line):**
- \`flowchart\` / \`graph\`
- \`sequenceDiagram\`
- \`classDiagram\`
- \`stateDiagram\` / \`stateDiagram-v2\`
- \`erDiagram\`
- \`journey\`
- \`gantt\`
- \`pie\`
- \`gitGraph\`

**Core Syntax Rules:**
1. **IDs:** Start with a letter; use letters/numbers/underscore only.
   - Valid: \`User_Login\`, \`Node1\`
   - Invalid: \`User Login\`, \`Node@1\`, \`Node-1\`
2. **ID + Label Pattern:** Use \`ID[Label]\` when label has spaces.
   - \`User_Login[User Login]\`
3. **Arrows (flowchart/graph):** Use valid arrows only: \`-->\`, \`-.->\`, \`==>\`.
   - Labeled edge format: \`A -->|Yes| B\`
   - Never insert free text inside the arrow itself.
   - Invalid: \`A -- IF OK --> B\`
   - Correct: \`A -->|IF OK| B\`
   - Do not use destroy/cross variants like \`---x\`, \`--x\`, \`x--\`, \`x---\` in flowcharts.
   - If you mean invalidation/removal/stop, use \`-.->|Invalidate|\` or \`-->|Stop|\`.
4. **Direction (flowchart/graph):** Prefer explicit direction (\`TD\`, \`LR\`, \`RL\`, \`BT\`).
5. **Subgraphs:** Always close with \`end\`.
   - Use explicit safe form: \`subgraph Subgraph_ID["Readable Label"]\`
   - Do not use raw quoted subgraph names like \`subgraph "Region A"\`
6. **No mixed types:** Do not mix flowchart syntax with sequence/class/state syntax.
7. **Balanced blocks:** Close every opened block; avoid dangling tokens.

**Flowchart Safety Rules:**
1. Use simple labels; avoid complex punctuation in node text.
2. Replace risky chars in labels when needed: \`:\` -> \`-\`, \`&\` -> \`and\`, \`;\` -> remove, \`/\` -> \`and\`.
3. Decision nodes should be short: \`Check_OK{Check OK?}\`.
4. **Edge labels must be short and plain text only.**
   - Prefer 1-4 words.
   - Avoid parentheses, commas, colons, quotes, slashes, brackets inside edge labels.
   - Invalid: \`A -->|Issue Tokens (Access, ID, Refresh)| B\`
   - Correct: \`A -->|Issue Tokens| B\`
5. If an edge needs detailed explanation, create an intermediate node instead of a long edge label.
   - Correct:
     \`AuthZServer --> Token_Issue[Issue Access ID and Refresh Tokens]\`
     \`Token_Issue --> SPA\`
6. Reuse the same node ID consistently; do not switch between raw text and IDs for the same node.
7. For subgraphs, prefer explicit ID + label syntax when naming is long.
   - Prefer: \`subgraph Auth_Flow["Authentication and Authorization"]\`
8. Avoid parentheses in node labels.
   - Invalid: \`Frontend[Frontend (e.g., Next.js)]\`
   - Correct: \`Frontend[Frontend using Next.js]\`
9. Avoid \`e.g.\`, commas, and abbreviation-heavy prose in node labels.
   - Keep node labels short, literal, and parser-safe.
10. Replace parenthetical product references with plain phrasing.
   - Invalid: \`Knowledge_Base[Knowledge Base (AppFlowy)]\`
   - Correct: \`Knowledge_Base[Knowledge Base with AppFlowy]\`
11. For subgraphs with special characters like \`&\`, always use explicit safe IDs and plain labels.
   - Invalid: \`subgraph Data & Knowledge Management\`
   - Correct: \`subgraph DataAndKnowledgeManagement["Data and Knowledge Management"]\`
12. Prefer node labels without slash-separated phrases.
   - Invalid: \`L1A -->|L1 Miss / Write-through| L2A\`
   - Correct: \`L1A -->|L1 Miss| L2A\`
   - Or move detail into a node: \`Write_Through[Write Through Path]\`
13. Production-safe bias: choose the most boring valid Mermaid syntax over expressive syntax.
   - Prefer simple arrows, short labels, explicit IDs, and extra nodes instead of clever notation.
14. Avoid escaped quotes inside labels.
   - Invalid: \`D["AI Model (The \\"Brain\\")"]\`
   - Correct: \`D[AI Model The Brain]\`
   - Correct: \`D[AI Model Brain]\`
   - If quoted wording is important, rewrite it as plain words instead of using escaped double quotes.
15. Avoid array literals, JSON-like values, and nested brackets inside labels.
   - Invalid: \`A[Array: ["_, ", " _, ", " _, ", " _"]]\`
   - Correct: \`A[Array With Four Slots]\`
   - Correct: \`A[Input Array]\`
   - If a label contains example data, summarize the meaning in plain language instead of preserving the literal array text.
16. Avoid colon-heavy labels that read like code or serialized data.
   - Invalid: \`B[Left Pointer: Index 0]\`
   - Correct: \`B[Left Pointer Index 0]\`
17. Avoid numeric or symbolic edge labels when they are really step markers.
   - Invalid: \`A -->|1| D[Left < Right?]\`
   - Correct: \`A --> D[Left Less Than Right]\`
   - Or use short semantic labels like \`Yes\` or \`Next\`.
18. Avoid comparison operators and symbol-heavy prose in node labels when plain words are possible.
   - Invalid: \`D[Left < Right?]\`
   - Correct: \`D[Left Less Than Right]\`
19. Use safe subgraph declarations when titles are long or contain spaces, punctuation, or hyphens.
   - Invalid: \`subgraph Client-Side AI\`
   - Correct: \`subgraph Client_Side_AI["Client Side AI"]\`
20. Never put descriptive text after an arrow without node syntax.
   - Invalid: \`U --> Smallest_and_Isolated_Units: Functions, Services, Pure_Components\`
   - Correct: \`U --> Smallest_Isolated_Units[Functions Services and Pure Components]\`
21. If using \`style\`, the styled ID must exactly match a defined node or subgraph ID.
   - Invalid: \`style Unit fill:#33FF33\` when the node ID is \`U\`
   - Correct: \`style U fill:#33FF33\`
22. Avoid HTML tags like \`<br>\` in labels when a plain text label is enough.
   - Invalid: \`A[Your Application<br>(using any-llm)]\`
   - Correct: \`A[Your Application using any-llm]\`
23. Avoid quoted node references embedded directly in edges.
   - Invalid: \`A --> "B[AI Provider's API]"\`
   - Correct: \`A --> B[AI Providers API]\`
24. If an edge label is long, symbolic, or infrastructure-specific, move the meaning into an intermediate node.
   - Invalid: \`Web_App -->|Connects to 'my-db' (DNS)| DB_Container\`
   - Correct: \`Web_App --> Connect_DB[Connect to my-db by DNS]\`
     \`Connect_DB --> DB_Container\`
25. Do not preserve code-like config fragments inside edge labels.
   - Invalid: \`B -->|provider="openai"| C[OpenAI API]\`
   - Correct: \`B -->|OpenAI| C[OpenAI API]\`
26. Do not preserve array notation, object notation, or example literals inside node labels.
   - Invalid: \`A[Array: [10, 20, 30]]\`
   - Correct: \`A[Array Values]\`
27. Do not preserve parentheses-heavy infra labels when a plain phrase works.
   - Invalid: \`Ollama_Server[Ollama Server (localhost:11434)]\`
   - Correct: \`Ollama_Server[Ollama Server Localhost 11434]\`
28. Avoid pseudo-headings or explanatory sentences as node labels.
   - Invalid: \`J[Input Reference Changed? OR Event Originated Here? OR Async Pipe Emitted?]\`
   - Correct: \`J[OnPush Trigger Check]\`

**Readability Rules (mandatory):**
1. Edge labels must be visually short.
   - Target 1-3 words, hard limit 4 words.
   - If longer than 4 words, convert the action into a node.
2. Do not put full sentences on edges.
   - Invalid: \`A -->|Validate token and return data| B\`
   - Correct:
     \`A --> Validate_Token[Validate Token]\`
     \`Validate_Token --> Return_Data[Return Data]\`
     \`Return_Data --> B\`
3. Avoid self-loops when they carry important meaning.
   - Instead of \`AuthZServer -->|User Auth| AuthZServer\`, create an intermediate node like \`User_Login[User Login and Consent]\`.
4. Prefer more small nodes over fewer overloaded edges.
5. If a diagram has more than 8-10 labeled edges, simplify labels aggressively.
6. Keep node labels short enough to avoid multi-line wrapping where possible.
7. Avoid dense fan-out with repeated long labels; shorten repeated labels to a single shared action word.
8. If a flow is sequential and step-heavy, use intermediate action nodes rather than verbose arrow text.
9. Favor left-to-right or top-to-bottom layouts that reduce edge crossing.
10. The diagram must be readable at a glance, not just syntactically valid.

**Sequence Diagram Rules:**
1. Start with \`sequenceDiagram\`.
2. Use valid arrows: \`->>\`, \`-->>\`, \`-x\`.
3. Keep participant IDs simple (no spaces); use aliases if needed.

**Class/State/ER Rules:**
1. \`classDiagram\`: valid relation operators only (\`<|--\`, \`*--\`, \`o--\`, \`-->\`).
2. \`stateDiagram\`: use \`[*]\` start/end where relevant.
3. \`erDiagram\`: use valid cardinalities (\`||\`, \`o|\`, \`|{\`, \`o{\`).

**Preflight Checklist (mandatory before finalizing):**
- Header is valid and matches syntax used.
- All IDs are valid.
- All arrows/operators are valid for that diagram type.
- Subgraphs/blocks are closed.
- No edge label contains long prose or punctuation-heavy text.
- No arrow contains inline text outside \`|label|\`.
- No quoted raw subgraph declarations.
- No \`---x\` or similar destroy-style flowchart arrows.
- No slash-heavy labels like \`A / B / C\`.
- No self-loop with a verbose label.
- No sentence-like edge labels.
- Diagram remains visually readable without overlapping text blocks.
- Mermaid can render in CLI without parse errors.`;

const MERMAID_FIXER_SYSTEM_PROMPT = `\
You are a Mermaid diagram syntax fixer.
Your job is to repair broken Mermaid while preserving meaning with minimal edits.

${MERMAID_AGENT_VALIDATION_BLOCK}

Additional fixer requirements:
1. Preserve business meaning and existing structure unless syntax requires a change.
2. Prefer the smallest safe fix over rewriting the whole diagram.
3. Return exactly one fenced Mermaid block and nothing else.
4. If the original diagram is already valid, return it unchanged inside one fenced Mermaid block.
5. Expected final shape:
   \`\`\`mermaid
   <diagram>
   \`\`\`
`;
