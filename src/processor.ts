import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDefaultReportPath, type Config } from "./config.js";
import type { LogLevel, ProgressState, Reporter } from "./reporter.js";
import { MarkdownScanner } from "./scanner.js";
import { setValidatorVerbose, validateMermaid } from "./validator.js";
import { AiFixer } from "./fixer.js";
import {
  applyFixes,
  extractMermaidBlocks,
  getLineColumn,
  type MermaidBlock,
  normalizeMermaidSnippet,
} from "./utils.js";

export interface ProcessStats {
  totalFiles: number;
  scannedFiles: number;
  totalBlocks: number;
  invalidBlocks: number;
  fixedBlocks: number;
  failedFixes: number;
}

// Internal record for a single broken block across phases
interface BrokenRecord {
  filePath: string;
  code: string; // normalized code sent to AI
  block: MermaidBlock; // original block with character offsets
  blockIndex: number; // 1-based index within the file
  blockTotal: number; // total blocks in the file
  line: number;
  column: number;
  diagramType: string;
  error: string;
  originalValidatorError?: string;
  aiOutputValidatorError?: string;
  lastAiResponse?: string;
  lastAiCandidate?: string;
}

interface DiagnosticsReport {
  scannedAt: string;
  rootDirectory: string;
  summary: ProcessStats;
  brokenBlocks: Array<{
    filePath: string;
    blockIndex: number;
    blockTotal: number;
    line: number;
    column: number;
    diagramType: string;
    error: string;
    code: string;
    status: "broken" | "fixed" | "failed";
    fixedCode?: string;
    fixError?: string;
    originalValidatorError?: string;
    aiOutputValidatorError?: string;
    aiRawResponse?: string;
    aiCandidate?: string;
  }>;
}

const BAR = "━".repeat(56);

export class MermaidProcessor {
  private scanner: MarkdownScanner;
  private fixer: AiFixer | null;
  private verbose: boolean;
  private config: Config;
  private reporter?: Reporter;

  constructor(
    config: Config,
    dryRun: boolean,
    verbose: boolean,
    reporter?: Reporter,
  ) {
    this.config = config;
    this.scanner = new MarkdownScanner(config.scan.exclude_patterns ?? []);
    this.fixer = dryRun ? null : new AiFixer(config);
    this.verbose = verbose;
    this.reporter = reporter;
    setValidatorVerbose(verbose);
  }

  async processDirectory(dir: string, dryRun: boolean): Promise<ProcessStats> {
    // ── PHASE 1: Scan & detect ────────────────────────────────────────────
    this.printPhaseHeader("📁  PHASE 1 — Scanning & detecting broken diagrams");

    const files = await this.scanner.scanDirectory(dir);
    this.log("info", `Found ${files.length} markdown file(s) in directory`);
    this.startPhase({
      phase: "scan",
      title: "Scanning For Broken Code",
      current: 0,
      total: files.length,
      detail: "Preparing scan",
      status: `0/${files.length}`,
    });

    const stats: ProcessStats = {
      totalFiles: files.length,
      scannedFiles: 0,
      totalBlocks: 0,
      invalidBlocks: 0,
      fixedBlocks: 0,
      failedFixes: 0,
    };

    // Cache file contents so we don't re-read in Phase 3
    const fileContents = new Map<string, string>();
    const broken: BrokenRecord[] = [];

    for (const filePath of files) {
      this.updateProgress({
        phase: "scan",
        title: "Scanning For Broken Code",
        current: stats.scannedFiles,
        total: files.length,
        detail: shortenMiddle(filePath, 110),
        status: `scanned=${stats.scannedFiles}/${files.length}`,
      });
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
        fileContents.set(filePath, content);
        stats.scannedFiles++;
        this.updateProgress({
          phase: "scan",
          title: "Scanning For Broken Code",
          current: stats.scannedFiles,
          total: files.length,
          detail: shortenMiddle(filePath, 110),
          status: `scanned=${stats.scannedFiles}/${files.length}`,
        });
      } catch (err) {
        this.log(
          "warn",
          `Cannot read: ${filePath}\n       ${
            err instanceof Error ? err.message : err
          }`,
        );
        continue;
      }

      const blocks = extractMermaidBlocks(content);
      if (blocks.length === 0) {
        if (this.verbose) this.log("detail", `No mermaid blocks: ${filePath}`);
        continue;
      }

      stats.totalBlocks += blocks.length;

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const code = normalizeMermaidSnippet(block.code);
        const result = await validateMermaid(code);

        if (result.valid) {
          if (this.verbose) {
            this.log(
              "success",
              `${filePath} — block ${i + 1}/${blocks.length}: valid`,
            );
          }
          continue;
        }

        stats.invalidBlocks++;
        const location = getLineColumn(content, block.start);
        broken.push({
          filePath,
          code,
          block,
          blockIndex: i + 1,
          blockTotal: blocks.length,
          line: location.line,
          column: location.column,
          diagramType: detectDiagramType(code),
          error: result.error ?? "unknown error",
          originalValidatorError: result.error ?? "unknown error",
        });

        if (this.verbose) {
          this.log(
            "error",
            `${filePath} — block ${i + 1}/${blocks.length}: ${result.error}`,
          );
        }
      }
    }

    this.updateProgress({
      phase: "scan",
      title: "Scanning For Broken Code",
      current: files.length,
      total: files.length,
      detail: "Scan complete",
      status: `broken=${stats.invalidBlocks} / total=${stats.totalBlocks}`,
    });

    this.log("info", `Mermaid blocks total:  ${stats.totalBlocks}`);
    this.log("info", `Broken blocks found:   ${stats.invalidBlocks}`);
    await this.writeDiagnosticsReport(dir, stats, broken);

    if (broken.length === 0) {
      this.log("success", "All diagrams look good — nothing to fix.");
      return stats;
    }

    if (dryRun) {
      this.log("info", "(dry-run — no changes will be made)");
      for (const r of broken) {
        this.log(
          "error",
          `${r.filePath}  block ${r.blockIndex}/${r.blockTotal}: ${r.error}`,
        );
      }
      return stats;
    }

    // ── PHASE 2: Fix with AI ──────────────────────────────────────────────
    this.printPhaseHeader("🤖  PHASE 2 — Fixing broken diagrams with AI");
    this.startPhase({
      phase: "fix",
      title: "Fixing With AI",
      current: 0,
      total: broken.length,
      success: 0,
      failure: 0,
      model: this.config.llm.model,
      detail: "Waiting for first diagram",
      status: "0% complete",
    });

    // filePath → list of {block, fixedCode} pairs to write in Phase 3
    const fixMap = new Map<
      string,
      Array<{ block: MermaidBlock; fixedCode: string }>
    >();

    for (let idx = 0; idx < broken.length; idx++) {
      const r = broken[idx];
      const relPath = r.filePath.split("/").slice(-3).join("/");
      this.updateProgress({
        phase: "fix",
        title: "Fixing With AI",
        current: idx,
        total: broken.length,
        success: stats.fixedBlocks,
        failure: stats.failedFixes,
        model: this.config.llm.model,
        detail: `${relPath}  (block ${r.blockIndex}/${r.blockTotal})`,
        status: `ready ${idx + 1}/${broken.length}`,
      });
      this.log("info", `[${idx + 1}/${broken.length}] ${"─".repeat(34)}`);
      this.log("info", `🔧 ${relPath}  (block ${r.blockIndex}/${r.blockTotal})`);
      if (this.verbose) this.log("detail", `error: ${r.error}`);

      try {
        const attempt = await this.fixer!.fixMermaid(r.code, r.error);
        r.lastAiResponse = attempt.rawResponse;
        r.lastAiCandidate = attempt.fixedCode;

        if (this.verbose) {
          this.log("detail", "AI raw response:");
          printIndentedBlock(attempt.rawResponse, "  ", this.reporter);
          this.log("detail", "AI extracted Mermaid:");
          printIndentedBlock(attempt.fixedCode, "  ", this.reporter);
        }

        const validation = await validateMermaid(attempt.fixedCode);
        if (!validation.valid) {
          r.aiOutputValidatorError = validation.error ?? "parse error";
          throw new Error(
            `LLM returned invalid Mermaid: ${
              validation.error ?? "parse error"
            }`,
          );
        }
        if (!fixMap.has(r.filePath)) fixMap.set(r.filePath, []);
        fixMap.get(r.filePath)!.push({
          block: r.block,
          fixedCode: attempt.fixedCode,
        });
        r.code = attempt.fixedCode;
        stats.fixedBlocks++;
        this.log("success", "LLM returned replacement");
      } catch (err) {
        stats.failedFixes++;
        r.error = err instanceof Error ? err.message : String(err);
        this.log("error", `AI error: ${r.error}`);
        if (this.verbose) {
          if (r.originalValidatorError) {
            this.log("detail", `original validator: ${r.originalValidatorError}`);
          }
          if (r.aiOutputValidatorError) {
            this.log("detail", `AI output validator: ${r.aiOutputValidatorError}`);
          }
          if (r.lastAiCandidate) {
            this.log("detail", "candidate Mermaid:");
            printIndentedBlock(r.lastAiCandidate, "  ", this.reporter);
          }
        }
      }

      this.updateProgress({
        phase: "fix",
        title: "Fixing With AI",
        current: idx + 1,
        total: broken.length,
        success: stats.fixedBlocks,
        failure: stats.failedFixes,
        model: this.config.llm.model,
        detail: `${relPath}  (block ${r.blockIndex}/${r.blockTotal})`,
        status: `ok=${stats.fixedBlocks} fail=${stats.failedFixes} left=${Math.max(0, broken.length - (idx + 1))}`,
      });
    }

    await this.writeDiagnosticsReport(dir, stats, broken, fixMap);

    if (fixMap.size === 0) {
      this.log("warn", "No fixes to write.");
      return stats;
    }

    // ── PHASE 3: Write files ──────────────────────────────────────────────
    this.printPhaseHeader("💾  PHASE 3 — Writing fixed files");
    this.startPhase({
      phase: "write",
      title: "Writing Fixed Files",
      current: 0,
      total: fixMap.size,
      detail: "Preparing writes",
      status: `0/${fixMap.size}`,
    });

    let writeIndex = 0;
    for (const [filePath, fixes] of fixMap) {
      writeIndex++;
      this.updateProgress({
        phase: "write",
        title: "Writing Fixed Files",
        current: writeIndex - 1,
        total: fixMap.size,
        detail: shortenMiddle(filePath, 110),
        status: `${writeIndex}/${fixMap.size}`,
      });
      const original = fileContents.get(filePath)!;
      const updated = applyFixes(original, fixes);
      try {
        await writeFile(filePath, updated, "utf8");
        this.log("success", `Written: ${filePath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log("error", `Cannot write ${filePath}: ${msg}`);
        // Roll back fix count since the write failed
        stats.fixedBlocks -= fixes.length;
        stats.failedFixes += fixes.length;
      }
      this.updateProgress({
        phase: "write",
        title: "Writing Fixed Files",
        current: writeIndex,
        total: fixMap.size,
        detail: shortenMiddle(filePath, 110),
        status: `${writeIndex}/${fixMap.size}`,
      });
    }

    this.reporter?.finish?.(stats, dryRun);
    return stats;
  }

  private async writeDiagnosticsReport(
    dir: string,
    stats: ProcessStats,
    broken: BrokenRecord[],
    fixMap?: Map<string, Array<{ block: MermaidBlock; fixedCode: string }>>,
  ): Promise<void> {
    const fixedBlocks = new Set<string>();
    if (fixMap) {
      for (const [filePath, fixes] of fixMap) {
        for (const fix of fixes) {
          fixedBlocks.add(this.getBlockKey(filePath, fix.block));
        }
      }
    }

    const report: DiagnosticsReport = {
      scannedAt: new Date().toISOString(),
      rootDirectory: dir,
      summary: { ...stats },
      brokenBlocks: broken.map((record) => {
        const key = this.getBlockKey(record.filePath, record.block);
        const wasFixed = fixedBlocks.has(key);

        return {
          filePath: record.filePath,
          blockIndex: record.blockIndex,
          blockTotal: record.blockTotal,
          line: record.line,
          column: record.column,
          diagramType: record.diagramType,
          error: record.error,
          code: record.block.code,
          status: wasFixed ? "fixed" : (fixMap ? "failed" : "broken"),
          fixedCode: wasFixed ? record.code : undefined,
          fixError: !wasFixed && fixMap ? record.error : undefined,
          originalValidatorError: record.originalValidatorError,
          aiOutputValidatorError: record.aiOutputValidatorError,
          aiRawResponse: record.lastAiResponse,
          aiCandidate: record.lastAiCandidate,
        };
      }),
    };

    const reportPath = this.getReportPath(dir);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify(report, null, 2) + "\n",
      "utf8",
    );
    this.reporter?.reportPath?.(reportPath);
    this.log("info", `Report: ${reportPath}`);
  }

  private getReportPath(dir: string): string {
    const configured = this.config.report.path?.trim();
    if (configured) return configured;
    return getDefaultReportPath();
  }

  private getBlockKey(filePath: string, block: MermaidBlock): string {
    return `${filePath}:${block.start}:${block.end}`;
  }

  private printPhaseHeader(title: string): void {
    if (this.reporter) return;
    console.log(`\n${BAR}`);
    console.log(title);
    console.log(BAR);
  }

  private startPhase(state: ProgressState): void {
    this.reporter?.startPhase?.(state);
  }

  private updateProgress(state: ProgressState): void {
    this.reporter?.updateProgress?.(state);
  }

  private log(level: LogLevel, message: string): void {
    if (this.reporter?.log) {
      this.reporter.log(level, message);
      return;
    }

    const prefix = {
      info: "   ",
      success: "   ✅ ",
      warn: "   ⚠️  ",
      error: "   ❌ ",
      detail: "      ",
    }[level];

    for (const [index, line] of message.split("\n").entries()) {
      const linePrefix = index === 0 ? prefix : "       ";
      console.log(`${linePrefix}${line}`);
    }
  }
}

function detectDiagramType(code: string): string {
  const firstLine = code.trim().split("\n", 1)[0]?.trim();
  if (!firstLine) return "unknown";
  return firstLine.split(/\s+/)[0];
}

function shortenMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const keep = Math.max(8, Math.floor((maxLength - 1) / 2));
  return `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

function printIndentedBlock(
  text: string,
  indent: string,
  reporter?: Reporter,
): void {
  const normalized = text.trim().length > 0 ? text.trimEnd() : "(empty)";
  for (const line of normalized.split("\n")) {
    if (reporter?.log) reporter.log("detail", `${indent}${line}`);
    else console.log(`${indent}${line}`);
  }
}
