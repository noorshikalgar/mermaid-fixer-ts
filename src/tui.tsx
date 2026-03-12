import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import chalk from "chalk";
import type { Reporter, ProgressState, LogLevel } from "./reporter.js";
import type { ProcessStats } from "./processor.js";

interface LogEntry {
  level: LogLevel;
  lines: string[];
}

interface MermaidFixerAppProps {
  directory: string;
  model: string;
  run: (reporter: Reporter) => Promise<ProcessStats>;
  onComplete: (stats: ProcessStats) => void;
  onError: (error: unknown) => void;
}

export function MermaidFixerApp(
  { directory, model, run, onComplete, onError }: MermaidFixerAppProps,
): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const size = useTerminalSize(stdout);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState<ProgressState>({
    phase: "scan",
    title: "Booting",
    current: 0,
    total: 1,
    detail: "Preparing mermaid fixer",
    status: "idle",
  });
  const [reportPath, setReportPath] = useState("");
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [finished, setFinished] = useState(false);
  const [started, setStarted] = useState(false);

  useInput((input) => {
    if (finished) return;
    if (showQuitConfirm) {
      if (input.toLowerCase() === "y") {
        process.exit(130);
      }
      if (input.toLowerCase() === "n" || input === "\u001b") {
        setShowQuitConfirm(false);
      }
      return;
    }

    if (input.toLowerCase() === "q") {
      setShowQuitConfirm(true);
    }
  });

  useEffect(() => {
    if (started) return;
    setStarted(true);

    const reporter: Reporter = {
      startPhase: (state) => setProgress(state),
      updateProgress: (state) => setProgress(state),
      log: (level, message) => {
        const lines = message.split("\n");
        setLogs((prev) => [...prev, { level, lines }].slice(-400));
      },
      reportPath: (path) => setReportPath(path),
      finish: (stats) => {
        setFinished(true);
        onComplete(stats);
        exit();
      },
    };

    void run(reporter).catch((error) => {
      onError(error);
      exit();
    });
  }, [started, run, onComplete, onError, exit]);

  const theme = useMemo(() => ({
    bg: "#0d1021",
    panel: "#171a30",
    border: "#5df2c7",
    accent: "#f3c969",
    success: "#76ff7a",
    danger: "#ff6b6b",
    info: "#67d4ff",
    dim: "#7d84a6",
    text: "#d8e1ff",
  }), []);

  const flattenedLogs = useMemo(() => {
    return logs.flatMap((entry) => entry.lines.map((line) => ({
      level: entry.level,
      line,
    })));
  }, [logs]);

  const width = size.width;
  const height = size.height;
  const showConfirm = showQuitConfirm ? 5 : 0;
  const headerHeight = 5;
  const footerHeight = 7;
  const bodyHeight = Math.max(6, height - headerHeight - footerHeight - showConfirm);
  const visibleLogs = flattenedLogs.slice(-Math.max(1, bodyHeight - 2));
  const percent = Math.min(
    100,
    Math.max(
      0,
      ((progress.success ?? progress.current) + (progress.failure ?? 0)) /
        Math.max(1, progress.total) * 100,
    ),
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box
        borderStyle="double"
        borderColor={theme.border}
        flexDirection="column"
        paddingX={1}
        height={headerHeight}
        flexShrink={0}
      >
        <Text>{chalk.hex(theme.accent)("MERMAID FIXER // RETRO CONSOLE")}</Text>
        <Text color={theme.text}>
          {chalk.hex(theme.info)(shorten(directory, Math.max(30, width - 20)))}
        </Text>
        <Text color={theme.dim}>
          {`phase=${progress.phase.toUpperCase()}  model=${model}  q=quit`}
        </Text>
      </Box>

      <Box
        height={bodyHeight}
        borderStyle="round"
        borderColor={theme.info}
        paddingX={1}
        flexDirection="column"
        flexShrink={0}
      >
        <Text>{chalk.hex(theme.info)("LOG STREAM")}</Text>
        <Box flexDirection="column">
          {visibleLogs.length === 0
            ? <Text color={theme.dim}>waiting for activity...</Text>
            : visibleLogs.map((entry, index) => (
              <Text key={`${index}-${entry.line}`} wrap="truncate-end">
                {formatLogLine(entry.level, entry.line, theme)}
              </Text>
            ))}
        </Box>
      </Box>

      <Box flexDirection="column" height={footerHeight} flexShrink={0}>
        <Box
          borderStyle="double"
          borderColor={theme.accent}
          paddingX={1}
          flexDirection="column"
          height={footerHeight}
        >
          <Text>
            {chalk.hex(theme.accent)("STATUS")} {chalk.hex(theme.info)(`${Math.min(progress.current, progress.total)}/${progress.total}`)}
          </Text>
          <Text color={theme.text}>{progress.detail ?? "working..."}</Text>
          <Text color={theme.dim}>{progress.status ?? "in progress"}</Text>
          <Text>{renderBar(width - 8, percent, progress.success ?? 0, progress.failure ?? 0, progress.total, theme)}</Text>
          <Text color={theme.dim}>
            {`done=${percent.toFixed(1)}%  ok=${progress.success ?? 0}  fail=${progress.failure ?? 0}  report=${reportPath || "pending"}`}
          </Text>
        </Box>
      </Box>

      {showQuitConfirm && (
        <Box
          height={showConfirm}
          width={Math.min(60, width - 4)}
          borderStyle="double"
          borderColor={theme.danger}
          paddingX={1}
          flexDirection="column"
        >
          <Text>{chalk.hex(theme.danger)("QUIT MERMAID FIXER?")}</Text>
          <Text color={theme.text}>The current run will stop immediately.</Text>
          <Text color={theme.dim}>Press `y` to quit or `n` to continue.</Text>
        </Box>
      )}
    </Box>
  );
}

function useTerminalSize(stdout: NodeJS.WriteStream): { width: number; height: number } {
  const [size, setSize] = useState({
    width: stdout.columns ?? 100,
    height: stdout.rows ?? 30,
  });

  useEffect(() => {
    const onResize = () => {
      setSize({
        width: stdout.columns ?? 100,
        height: stdout.rows ?? 30,
      });
    };

    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

function renderBar(
  width: number,
  percent: number,
  success: number,
  failure: number,
  total: number,
  theme: Record<string, string>,
): string {
  const usableWidth = Math.max(10, width);
  const successWidth = Math.round((success / Math.max(1, total)) * usableWidth);
  const failureWidth = Math.round((failure / Math.max(1, total)) * usableWidth);
  const used = Math.min(usableWidth, successWidth + failureWidth);
  const pendingWidth = Math.max(0, usableWidth - used);

  return [
    chalk.hex(theme.dim)("["),
    chalk.hex(theme.success)("█".repeat(successWidth)),
    chalk.hex(theme.danger)("█".repeat(failureWidth)),
    chalk.hex(theme.dim)("░".repeat(pendingWidth)),
    chalk.hex(theme.dim)("]"),
    " ",
    chalk.hex(theme.accent)(`${percent.toFixed(1)}%`),
  ].join("");
}

function formatLogLine(level: LogLevel, line: string, theme: Record<string, string>): string {
  const prefix = {
    info: chalk.hex(theme.info)("›"),
    success: chalk.hex(theme.success)("✓"),
    warn: chalk.hex(theme.accent)("!"),
    error: chalk.hex(theme.danger)("x"),
    detail: chalk.hex(theme.dim)("·"),
  }[level];

  const color = {
    info: theme.text,
    success: theme.success,
    warn: theme.accent,
    error: theme.danger,
    detail: theme.dim,
  }[level];

  return `${prefix} ${chalk.hex(color)(line)}`;
}

function shorten(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const keep = Math.max(8, Math.floor((maxLength - 1) / 2));
  return `${text.slice(0, keep)}…${text.slice(-keep)}`;
}
