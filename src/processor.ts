import type { Config } from "./config.ts";
import { MarkdownScanner } from "./scanner.ts";
import { validateMermaid } from "./validator.ts";
import { AiFixer } from "./fixer.ts";
import {
  type MermaidBlock,
  applyFixes,
  extractMermaidBlocks,
  normalizeMermaidSnippet,
} from "./utils.ts";

export interface ProcessStats {
  totalFiles:    number;
  scannedFiles:  number;
  totalBlocks:   number;
  invalidBlocks: number;
  fixedBlocks:   number;
  failedFixes:   number;
}

// Internal record for a single broken block across phases
interface BrokenRecord {
  filePath:     string;
  code:         string;        // normalized code sent to AI
  block:        MermaidBlock;  // original block with character offsets
  blockIndex:   number;        // 1-based index within the file
  blockTotal:   number;        // total blocks in the file
  error:        string;
}

const BAR = "━".repeat(56);

export class MermaidProcessor {
  private scanner: MarkdownScanner;
  private fixer:   AiFixer | null;
  private verbose: boolean;

  constructor(config: Config, dryRun: boolean, verbose: boolean) {
    this.scanner = new MarkdownScanner(config.scan.exclude_patterns ?? []);
    this.fixer   = dryRun ? null : new AiFixer(config);
    this.verbose = verbose;
  }

  async processDirectory(dir: string, dryRun: boolean): Promise<ProcessStats> {
    // ── PHASE 1: Scan & detect ────────────────────────────────────────────
    console.log(`\n${BAR}`);
    console.log("📁  PHASE 1 — Scanning & detecting broken diagrams");
    console.log(BAR);

    const files = await this.scanner.scanDirectory(dir);
    console.log(`   Found ${files.length} markdown file(s) in directory`);

    const stats: ProcessStats = {
      totalFiles:    files.length,
      scannedFiles:  0,
      totalBlocks:   0,
      invalidBlocks: 0,
      fixedBlocks:   0,
      failedFixes:   0,
    };

    // Cache file contents so we don't re-read in Phase 3
    const fileContents = new Map<string, string>();
    const broken: BrokenRecord[] = [];

    for (const filePath of files) {
      let content: string;
      try {
        content = await Deno.readTextFile(filePath);
        fileContents.set(filePath, content);
        stats.scannedFiles++;
      } catch (err) {
        console.warn(`   ⚠️  Cannot read: ${filePath}\n       ${err instanceof Error ? err.message : err}`);
        continue;
      }

      const blocks = extractMermaidBlocks(content);
      if (blocks.length === 0) {
        if (this.verbose) console.log(`   ℹ️  No mermaid blocks: ${filePath}`);
        continue;
      }

      stats.totalBlocks += blocks.length;

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const code  = normalizeMermaidSnippet(block.code);
        const result = validateMermaid(code);

        if (result.valid) {
          if (this.verbose) console.log(`   ✅ ${filePath} — block ${i + 1}/${blocks.length}: valid`);
          continue;
        }

        stats.invalidBlocks++;
        broken.push({
          filePath,
          code,
          block,
          blockIndex: i + 1,
          blockTotal: blocks.length,
          error: result.error ?? "unknown error",
        });

        if (this.verbose) {
          console.log(`   ❌ ${filePath} — block ${i + 1}/${blocks.length}: ${result.error}`);
        }
      }
    }

    console.log(`   Mermaid blocks total:  ${stats.totalBlocks}`);
    console.log(`   Broken blocks found:   ${stats.invalidBlocks}`);

    if (broken.length === 0) {
      console.log(`\n   ✅ All diagrams look good — nothing to fix.`);
      return stats;
    }

    if (dryRun) {
      console.log(`\n   (dry-run — no changes will be made)`);
      for (const r of broken) {
        console.log(`   ❌ ${r.filePath}  block ${r.blockIndex}/${r.blockTotal}: ${r.error}`);
      }
      return stats;
    }

    // ── PHASE 2: Fix with AI ──────────────────────────────────────────────
    console.log(`\n${BAR}`);
    console.log("🤖  PHASE 2 — Fixing broken diagrams with AI");
    console.log(BAR);

    // filePath → list of {block, fixedCode} pairs to write in Phase 3
    const fixMap = new Map<string, Array<{ block: MermaidBlock; fixedCode: string }>>();

    for (let idx = 0; idx < broken.length; idx++) {
      const r       = broken[idx];
      const label   = `[${idx + 1}/${broken.length}]`;
      const relPath = r.filePath.split("/").slice(-3).join("/");

      console.log(`   ${label} 🔧 ${relPath}  (block ${r.blockIndex}/${r.blockTotal})`);
      if (this.verbose) console.log(`         error: ${r.error}`);

      try {
        let fixed      = await this.fixer!.fixMermaid(r.code, r.error);
        let validation = validateMermaid(fixed);

        if (!validation.valid) {
          console.log(`         ⚠️  First attempt still invalid — retrying once...`);
          if (this.verbose) console.log(`         reason: ${validation.error}`);
          fixed      = await this.fixer!.fixMermaid(fixed, validation.error ?? r.error);
          validation = validateMermaid(fixed);
        }

        if (!validation.valid) {
          stats.failedFixes++;
          console.log(`         ❌ Still invalid after retry — skipped`);
          if (this.verbose) console.log(`         reason: ${validation.error}`);
          continue;
        }

        if (!fixMap.has(r.filePath)) fixMap.set(r.filePath, []);
        fixMap.get(r.filePath)!.push({ block: r.block, fixedCode: fixed });
        stats.fixedBlocks++;
        console.log(`         ✅ Fixed successfully`);
      } catch (err) {
        stats.failedFixes++;
        console.log(`         ❌ AI error: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (fixMap.size === 0) {
      console.log(`\n   No fixes to write.`);
      return stats;
    }

    // ── PHASE 3: Write files ──────────────────────────────────────────────
    console.log(`\n${BAR}`);
    console.log("💾  PHASE 3 — Writing fixed files");
    console.log(BAR);

    for (const [filePath, fixes] of fixMap) {
      const original = fileContents.get(filePath)!;
      const updated  = applyFixes(original, fixes);
      try {
        await Deno.writeTextFile(filePath, updated);
        console.log(`   ✅ Written: ${filePath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`   ❌ Cannot write ${filePath}: ${msg}`);
        // Roll back fix count since the write failed
        stats.fixedBlocks -= fixes.length;
        stats.failedFixes += fixes.length;
      }
    }

    return stats;
  }
}
