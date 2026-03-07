import mermaid from "npm:mermaid";

/**
 * Mermaid parser wrapper.
 *
 * This is intentionally strict and simple: if Mermaid parse throws for any
 * reason, the block is treated as broken and may be sent to the LLM.
 */

// Common Mermaid diagram types supported by recent Mermaid releases.
const VALID_TYPES = new Set([
  "graph",
  "flowchart",
  "sequencediagram",
  "classdiagram",
  "statediagram",
  "statediagram-v2",
  "erdiagram",
  "gantt",
  "pie",
  "gitgraph",
  "mindmap",
  "kanban",
  "timeline",
  "xychart-beta",
  "quadrantchart",
  "requirementdiagram",
  "c4context",
  "c4container",
  "c4component",
  "c4dynamic",
  "c4deployment",
  "journey",
  "block-beta",
  "packet",
  "architecture-beta",
  "zenuml",
  "sankey-beta",
  "radar-beta",
  "treemap-beta",
  "venn-beta",
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

export async function validateMermaid(code: string): Promise<ValidationResult> {
  const trimmed = code.trim();

  if (!trimmed) {
    return { valid: false, error: "Empty Mermaid block.", errorType: "EMPTY" };
  }

  const lines = trimmed.split("\n");
  const firstLine = lines[0].trim().toLowerCase();

  if (!firstLine) {
    return {
      valid: false,
      error: "Diagram has no type declaration on the first line.",
      errorType: "MISSING_TYPE",
    };
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

  try {
    await mermaid.parse(trimmed);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: (err instanceof Error ? err.message : String(err)).replace(
        /^Error:\s*/,
        "",
      ).trim(),
      errorType: "SYNTAX_HINT",
    };
  }
}
