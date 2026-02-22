import type { Config } from "./config.ts";
import { MarkdownScanner } from "./scanner.ts";
import { validateMermaid } from "./validator.ts";
import { AiFixer } from "./fixer.ts";
import { extractMermaidBlocks, replaceMermaidBlock } from "./utils.ts";

export interface ProcessStats {
  totalFiles:    number;
  totalBlocks:   number;
  invalidBlocks: number;
  fixedBlocks:   number;
  failedFixes:   number;
}

export class MermaidProcessor {
  private scanner:  MarkdownScanner;
  private fixer:    AiFixer | null;
  private verbose:  boolean;

  constructor(config: Config, dryRun: boolean, verbose: boolean) {
    this.scanner = new MarkdownScanner(config.scan.exclude_patterns ?? []);
    this.fixer   = dryRun ? null : new AiFixer(config);
    this.verbose = verbose;
  }

  async processDirectory(dir: string, dryRun: boolean): Promise<ProcessStats> {
    if (this.verbose) console.log(`🚀 Scanning directory: ${dir}`);

    const files = await this.scanner.scanDirectory(dir);
    if (this.verbose) console.log(`📄 Found ${files.length} Markdown file(s)`);

    const stats: ProcessStats = {
      totalFiles:    files.length,
      totalBlocks:   0,
      invalidBlocks: 0,
      fixedBlocks:   0,
      failedFixes:   0,
    };

    for (const file of files) {
      if (this.verbose) console.log(`\n📝 Processing: ${file}`);
      const r = await this.processFile(file, dryRun);
      stats.totalBlocks   += r.totalBlocks;
      stats.invalidBlocks += r.invalidBlocks;
      stats.fixedBlocks   += r.fixedBlocks;
      stats.failedFixes   += r.failedFixes;
    }

    return stats;
  }

  private async processFile(
    filePath: string,
    dryRun: boolean,
  ): Promise<{ totalBlocks: number; invalidBlocks: number; fixedBlocks: number; failedFixes: number }> {
    let content: string;
    try {
      content = await Deno.readTextFile(filePath);
    } catch (err) {
      console.warn(`   ⚠️  Cannot read file: ${err instanceof Error ? err.message : err}`);
      return { totalBlocks: 0, invalidBlocks: 0, fixedBlocks: 0, failedFixes: 0 };
    }

    const blocks = extractMermaidBlocks(content);

    if (blocks.length === 0) {
      if (this.verbose) console.log("   ℹ️  No Mermaid blocks found");
      return { totalBlocks: 0, invalidBlocks: 0, fixedBlocks: 0, failedFixes: 0 };
    }

    if (this.verbose) console.log(`   🔍 Found ${blocks.length} Mermaid block(s)`);

    let invalidBlocks = 0;
    let fixedBlocks   = 0;
    let failedFixes   = 0;
    let newContent    = content;

    for (let i = 0; i < blocks.length; i++) {
      const { code } = blocks[i];
      if (this.verbose) console.log(`      📊 Validating block ${i + 1}/${blocks.length}`);

      const result = validateMermaid(code);

      if (result.valid) {
        if (this.verbose) console.log("         ✅ Block is valid");
        continue;
      }

      if (this.verbose) console.log(`         ❌ Block is invalid: ${result.error}`);
      invalidBlocks++;

      if (!dryRun && this.fixer) {
        console.log(`         🤖 Sending to AI for fix...`);
        try {
          const fixed = await this.fixer.fixMermaid(code);
          if (fixed && fixed.trim()) {
            newContent = replaceMermaidBlock(newContent, code, fixed);
            fixedBlocks++;
            console.log(`         🔧 Fix applied`);
          } else {
            failedFixes++;
            console.log(`         ⚠️  AI returned empty response — skipping`);
          }
        } catch (err) {
          failedFixes++;
          console.log(`         ❌ AI fix failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    if (newContent !== content) {
      await Deno.writeTextFile(filePath, newContent);
      if (this.verbose) console.log("   💾 File updated");
    }

    return { totalBlocks: blocks.length, invalidBlocks, fixedBlocks, failedFixes };
  }
}
