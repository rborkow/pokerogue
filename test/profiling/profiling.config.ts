/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// NB: We cannot use `#XYZ` imports in this file since `vite-tsconfig-paths` has not been initialized yet.

import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vite.config.ts";

/**
 * Vitest config for the opt-in battle profiling workflows (`pnpm profile:battle`, `pnpm profile:replay`).
 * These runs are long and write files, so they are excluded from the normal test suite.
 */
// biome-ignore lint/style/noDefaultExport: required for vitest
export default defineConfig(async config => ({
  ...(await sharedConfig(config)),
  test: {
    env: { TZ: "UTC" },
    isolate: false,
    environment: "jsdom" as const,
    environmentOptions: { jsdom: { resources: "usable" as const } },
    setupFiles: ["./test/setup/font-face.setup.ts", "./test/setup/vitest.setup.ts", "./test/setup/matchers.setup.ts"],
    include: ["./test/profiling/**/*.profile.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    restoreMocks: true,
    silent: "passed-only" as const,
    watch: false,
  },
}));
