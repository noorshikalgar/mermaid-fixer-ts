import type { ProcessStats } from "./processor.js";

export type LogLevel = "info" | "success" | "warn" | "error" | "detail";
export type PhaseName = "scan" | "fix" | "write" | "summary";

export interface ProgressState {
  phase: PhaseName;
  title: string;
  current: number;
  total: number;
  success?: number;
  failure?: number;
  model?: string;
  detail?: string;
  status?: string;
}

export interface Reporter {
  startPhase?(state: ProgressState): void;
  updateProgress?(state: ProgressState): void;
  log?(level: LogLevel, message: string): void;
  reportPath?(path: string): void;
  finish?(stats: ProcessStats, dryRun: boolean): void;
}

