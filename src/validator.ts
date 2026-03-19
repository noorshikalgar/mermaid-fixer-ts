import { JSDOM } from "jsdom";

export type ValidationErrorType =
  | "EMPTY"
  | "MISSING_TYPE"
  | "EMPTY_BODY"
  | "SYNTAX_HINT";

export interface ValidationResult {
  valid: boolean;
  error?: string;
  errorType?: ValidationErrorType;
}

type MermaidModule = typeof import("mermaid");

let mermaidPromise: Promise<MermaidModule["default"]> | null = null;
let validatorVerbose = false;

export function setValidatorVerbose(enabled: boolean): void {
  validatorVerbose = enabled;
}

export async function validateMermaid(code: string): Promise<ValidationResult> {
  const trimmed = code.trim();
  let parseError = "";

  if (!trimmed) {
    return { valid: false, error: "Empty Mermaid block.", errorType: "EMPTY" };
  }

  const lines = trimmed.split("\n");
  const firstLine = lines[0]?.trim() ?? "";

  if (!firstLine) {
    return {
      valid: false,
      error: "Diagram has no type declaration on the first line.",
      errorType: "MISSING_TYPE",
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
    const mermaid = await getMermaid();
    mermaid.parseError = (error) => {
      parseError = typeof error === "string" ? error : String(error);
      if (validatorVerbose) {
        console.error("[mermaid.parseError]", parseError);
      }
    };

    if (validatorVerbose) {
      console.error("[mermaid.validate] input:");
      console.error(trimmed);
    }

    const result = await mermaid.parse(trimmed);
    if (validatorVerbose) {
      console.error("[mermaid.parse] returned:", result);
    }

    return { valid: true };
  } catch (err) {
    if (validatorVerbose) {
      console.error("[mermaid.parse] threw:", err);
    }
    const message = parseError || (err instanceof Error ? err.message : String(err));
    return {
      valid: false,
      error: message.replace(/^Error:\s*/, "").trim(),
      errorType: "SYNTAX_HINT",
    };
  }
}

async function getMermaid(): Promise<MermaidModule["default"]> {
  if (!mermaidPromise) {
    mermaidPromise = loadMermaid();
  }
  return mermaidPromise;
}

async function loadMermaid(): Promise<MermaidModule["default"]> {
  const { window } = new JSDOM("", { pretendToBeVisual: true });
  defineGlobal("window", window as unknown as Window & typeof globalThis);
  defineGlobal("document", window.document);
  defineGlobal("navigator", window.navigator);
  defineGlobal("DOMParser", window.DOMParser);
  defineGlobal("Element", window.Element);
  defineGlobal("HTMLElement", window.HTMLElement);
  defineGlobal("Node", window.Node);

  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
  });

  return mermaid;
}

function defineGlobal(name: string, value: unknown): void {
  const existing = Object.getOwnPropertyDescriptor(globalThis, name);

  if (!existing) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
    return;
  }

  if (existing.configurable) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
    return;
  }

  try {
    Reflect.set(globalThis, name, value);
  } catch {
    // Leave built-in read-only globals as-is.
  }
}
