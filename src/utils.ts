/** Extract all ```mermaid … ``` blocks from Markdown content. */
export interface MermaidBlock {
  code: string;
  /** Raw fence string used as the opening marker (e.g. "```mermaid") */
  fence: string;
}

export function extractMermaidBlocks(content: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  // Match ```mermaid … ``` (handles Windows line endings too)
  const re = /^([ \t]*```+[ \t]*mermaid[ \t]*)\r?\n([\s\S]*?)^([ \t]*```+[ \t]*)$/gm;

  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    blocks.push({ code: m[2].replace(/\r\n/g, "\n").trimEnd(), fence: m[1].trim() });
  }
  return blocks;
}

/** Replace the first occurrence of originalCode inside a mermaid fence with fixedCode. */
export function replaceMermaidBlock(
  content: string,
  originalCode: string,
  fixedCode: string,
): string {
  // Escape special regex chars in the original code
  const escaped = originalCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match the fence, then the exact original code, then the closing fence
  const pattern = new RegExp(
    `(\`\`\`+[ \\t]*mermaid[ \\t]*\\r?\\n)${escaped}(\\r?\\n\`\`\`+)`,
  );
  return content.replace(pattern, `$1${fixedCode}$2`);
}

/** Print a final statistics summary. */
export function printStatistics(
  stats: { totalFiles: number; totalBlocks: number; invalidBlocks: number; fixedBlocks: number; failedFixes: number },
  dryRun: boolean,
): void {
  console.log("\n📊 Processing complete:");
  console.log(`   📄 Files scanned:     ${stats.totalFiles}`);
  console.log(`   📊 Mermaid blocks:    ${stats.totalBlocks}`);
  console.log(`   ❌ Invalid blocks:    ${stats.invalidBlocks}`);
  if (!dryRun) {
    console.log(`   🔧 Fixed blocks:      ${stats.fixedBlocks}`);
    if (stats.failedFixes > 0) {
      console.log(`   ⚠️  Failed fixes:     ${stats.failedFixes}`);
    }
  }
}
