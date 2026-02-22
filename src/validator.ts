/**
 * Mermaid diagram validator.
 *
 * Uses a fast, zero-dependency structural approach:
 *  1. Checks the diagram has a recognised type declaration.
 *  2. Checks the body has actual content.
 *  3. Runs lightweight flowchart-specific checks.
 *
 * This avoids the false-positive problem seen with headless-Chrome-based
 * validators (e.g. mermaid-rs) that flag perfectly valid diagrams.
 */

// All diagram types recognised by Mermaid ≥ 10
const VALID_TYPES = new Set([
  "graph", "flowchart",
  "sequencediagram",
  "classdiagram",
  "statediagram", "statediagram-v2",
  "erdiagram",
  "gantt",
  "pie",
  "gitgraph",
  "mindmap",
  "timeline",
  "xychart-beta",
  "quadrantchart",
  "requirementdiagram",
  "c4context", "c4container", "c4component", "c4dynamic", "c4deployment",
  "journey",
  "block-beta",
  "packet-beta",
  "architecture-beta",
  "zenuml",
  "sankey-beta",
]);

export type ValidationErrorType =
  | "EMPTY"
  | "MISSING_TYPE"
  | "UNKNOWN_TYPE"
  | "EMPTY_BODY"
  | "SYNTAX_HINT";

export interface ValidationResult {
  valid: boolean;
  error?: string;
  errorType?: ValidationErrorType;
}

export function validateMermaid(code: string): ValidationResult {
  const trimmed = code.trim();

  if (!trimmed) {
    return { valid: false, error: "Empty Mermaid block.", errorType: "EMPTY" };
  }

  const lines = trimmed.split("\n");
  const firstLine = lines[0].trim().toLowerCase();

  if (!firstLine) {
    return { valid: false, error: "Diagram has no type declaration on the first line.", errorType: "MISSING_TYPE" };
  }

  // First token (strip trailing colon used by e.g. "gitGraph:")
  const firstToken = firstLine.split(/\s+/)[0].replace(/:$/, "");

  if (!VALID_TYPES.has(firstToken)) {
    return {
      valid: false,
      error: `Unknown diagram type "${firstToken}". ` +
        `Expected one of: graph, flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, gitGraph, mindmap, …`,
      errorType: "UNKNOWN_TYPE",
    };
  }

  // Body lines (strip comments)
  const body = lines.slice(1).filter((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith("%%");
  });

  if (body.length === 0) {
    return {
      valid: false,
      error: "Diagram has a type declaration but no content.",
      errorType: "EMPTY_BODY",
    };
  }

  // Extra checks for flowchart / graph diagrams
  if (firstToken === "graph" || firstToken === "flowchart") {
    const err = checkFlowchart(body);
    if (err) return { valid: false, error: err, errorType: "SYNTAX_HINT" };
  }

  return { valid: true };
}

/**
 * Lightweight flowchart checks.
 * Flags the most common real errors without producing false positives.
 */
function checkFlowchart(bodyLines: string[]): string | null {
  for (const line of bodyLines) {
    const t = line.trim();

    // Skip meta-lines
    if (
      !t ||
      t.startsWith("%%") ||
      t.startsWith("style ") ||
      t.startsWith("classDef ") ||
      t.startsWith("class ") ||
      t.startsWith("click ") ||
      t.startsWith("subgraph") ||
      t === "end"
    ) continue;

    // Arrow label with spaces or CJK chars that isn't quoted
    // Matches:  -- label -->  or  -- label ---  where label is not double-quoted
    const m = t.match(/--\s+([^"\s\-|>][^\-|>]*?)\s+(-{1,2}>|---)/);
    if (m) {
      const label = m[1].trim();
      // Only flag if it contains whitespace or non-ASCII (CJK etc.)
      if (/[\s\u4e00-\u9fff\u3040-\u30ff]/.test(label)) {
        return `Arrow label "${label}" contains spaces or non-ASCII characters — wrap it in double quotes, e.g. -- "${label}" -->`;
      }
    }
  }
  return null;
}
