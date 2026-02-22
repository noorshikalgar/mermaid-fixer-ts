import { extname, join } from "@std/path";

const SKIP_DIRS = new Set([
  ".git", ".svn", ".hg",
  "node_modules", "target", "build", "dist",
  ".vscode", ".idea", ".vs",
  "__pycache__", ".pytest_cache",
  "vendor", "deps",
]);

export class MarkdownScanner {
  private excludePatterns: RegExp[];

  constructor(extraPatterns: string[] = []) {
    // ._* (SMB share metadata) is always excluded automatically
    const all = ["^\\._", ...extraPatterns];
    this.excludePatterns = all.flatMap((p) => {
      try {
        return [new RegExp(p)];
      } catch {
        console.warn(`⚠️  Invalid exclude pattern '${p}' — skipping.`);
        return [];
      }
    });
  }

  async scanDirectory(dir: string): Promise<string[]> {
    const files: string[] = [];
    await this.walk(dir, files);
    return files;
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return; // unreadable directory — skip silently
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        if (!SKIP_DIRS.has(entry.name)) await this.walk(full, out);
      } else if (entry.isFile) {
        const ext = extname(entry.name).toLowerCase();
        if ((ext === ".md" || ext === ".markdown") && !this.isExcluded(entry.name)) {
          out.push(full);
        }
      }
    }
  }

  private isExcluded(filename: string): boolean {
    return this.excludePatterns.some((p) => p.test(filename));
  }
}
