#!/usr/bin/env node

import React from "react";
import { render } from "ink";
import { MermaidFixerApp } from "./tui.js";
import { runCli } from "./cli.js";
import type { ProcessStats } from "./processor.js";
import type { Reporter } from "./reporter.js";

async function main(): Promise<void> {
  await runCli({
    allowTui: true,
    launchTui: async (
      directory: string,
      model: string,
      run: (reporter?: Reporter) => Promise<ProcessStats>,
    ) => {
      let stats: ProcessStats | null = null;
      let runError: unknown = null;

      const app = render(
        React.createElement(MermaidFixerApp, {
          directory,
          model,
          run,
          onComplete: (value: ProcessStats) => {
            stats = value;
          },
          onError: (error: unknown) => {
            runError = error;
          },
        }),
        { exitOnCtrlC: false },
      );

      await app.waitUntilExit();

      if (runError) {
        throw runError;
      }
      if (!stats) {
        throw new Error("TUI exited before processing completed.");
      }

      return stats;
    },
  });
}

main();
