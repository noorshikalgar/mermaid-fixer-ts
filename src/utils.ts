/**
 * Represents a parsed ```mermaid ... ``` block with position metadata.
 * start/end reference character offsets in the parent document string,
 * enabling index-based replacement without regex on the full file content.
 */
export interface MermaidBlock {
  /** Content between the opening and closing fences (no fence lines). */
  code: string;
  /** The raw opening fence line (may be indented, e.g. "  ```mermaid"). */
  fence: string;
  /** Start char offset in the document (inclusive; points at the first ` of the opening fence). */
  start: number;
  /** End char offset in the document (exclusive; character after the last ` of the closing fence). */
  end: number;
}

/** Extract all ```mermaid … ``` blocks from Markdown content, with position metadata. */
export function extractMermaidBlocks(content: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  // Handles optional indentation on fences and Windows line endings.
  const re = /^([ \t]*`{3,}[ \t]*mermaid[ \t]*)\r?\n([\s\S]*?)^([ \t]*`{3,}[ \t]*)$/gm;

  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    let code = m[2].replace(/\r\n/g, "\n").trimEnd();
    let end  = m.index + m[0].length;

    // Double-fence pattern: the captured body starts with another fence line
    // e.g.  ```mermaid\n```mermaid\ngraph LR\n...\n```\n```
    // Strip the inner opening fence from code and consume the extra closing ```
    // line that trails in the document so the replacement is clean.
    const innerFirst = code.split("\n")[0].trim();
    if (/^`{3,}/.test(innerFirst)) {
      code = code.split("\n").slice(1).join("\n").trim();
      // Consume every immediately-following bare ``` line after the matched block.
      let rest = content.slice(end);
      let extra: RegExpMatchArray | null;
      while ((extra = rest.match(/^[ \t]*`{3,}[ \t]*(?:\r?\n|$)/)) !== null) {
        end  += extra[0].length;
        rest  = content.slice(end);
      }
    }

    blocks.push({ code, fence: m[1], start: m.index, end });
  }
  return blocks;
}

/** Normalize Mermaid snippet text before validation/LLM fixing. */
export function normalizeMermaidSnippet(code: string): string {
  let out = code.replace(/\r\n/g, "\n").trim();

  // Unwrap accidental nested / orphaned code fences within a mermaid block.
  for (let i = 0; i < 5; i++) {
    const lines = out.split("\n");
    if (lines.length < 2) break;

    const first = lines[0].trim();
    const last  = lines[lines.length - 1].trim();
    const isFenceStart = /^`{3,}/.test(first);
    const isFenceEnd   = /^`{3,}[ \t]*$/.test(last);

    if (isFenceStart && isFenceEnd) {
      // Fully wrapped — strip both fences
      out = lines.slice(1, -1).join("\n").trim();
    } else if (isFenceStart) {
      // Orphaned opening fence (no matching close) — strip just the first line
      out = lines.slice(1).join("\n").trim();
      break;
    } else {
      break;
    }
  }

  return out;
}

/**
 * Build a replacement fenced block with no indentation on either fence line.
 * Always outputs ```mermaid and ``` at column 0.
 */
export function buildReplacementBlock(fixedCode: string): string {
  return "```mermaid\n" + fixedCode.trim() + "\n```";
}

/**
 * Apply multiple fixes to a document in a single pass.
 * All blocks must reference positions in the SAME original content string.
 * Fixes are applied end-to-start so earlier character offsets stay valid.
 */
export function applyFixes(
  content: string,
  fixes: Array<{ block: MermaidBlock; fixedCode: string }>,
): string {
  // Sort descending by start index so each replacement doesn't shift earlier positions.
  const sorted = [...fixes].sort((a, b) => b.block.start - a.block.start);
  let result = content;
  for (const { block, fixedCode } of sorted) {
    const replacement = buildReplacementBlock(fixedCode);
    result = result.slice(0, block.start) + replacement + result.slice(block.end);
  }
  return result;
}

/** Print a final statistics summary. */
export function printStatistics(
  stats: {
    totalFiles: number;
    scannedFiles: number;
    totalBlocks: number;
    invalidBlocks: number;
    fixedBlocks: number;
    failedFixes: number;
  },
  dryRun: boolean,
): void {
  const bar = "━".repeat(52);
  console.log(`\n${bar}`);
  console.log("📊  Summary");
  console.log(bar);
  console.log(`   Files found:          ${stats.totalFiles}`);
  console.log(`   Files scanned:        ${stats.scannedFiles}`);
  console.log(`   Mermaid blocks found: ${stats.totalBlocks}`);
  console.log(`   Broken blocks:        ${stats.invalidBlocks}`);
  if (!dryRun) {
    console.log(`   Fixed:                ${stats.fixedBlocks}`);
    if (stats.failedFixes > 0) {
      console.log(`   Failed / skipped:     ${stats.failedFixes}`);
    }
  }
  console.log(bar);
}
