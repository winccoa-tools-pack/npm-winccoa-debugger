import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WinccoaProjectLifecycle } from '../test/helpers/WinccoaProjectLifecycle.js';

function collectTestFiles(rootDir: string): string[] {
    const out: string[] = [];
    const stack: string[] = [rootDir];

    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }

            if (entry.isFile() && entry.name.endsWith('.test.ts')) {
                out.push(fullPath);
            }
        }
    }

    return out.sort();
}

// Collect CLI args but ignore option-like args (starting with '-')
const rawArgs = process.argv.slice(2);
const targets = rawArgs.filter((a) => !a.startsWith('-'));
if (targets.length === 0) {
    console.error('Usage: node --import tsx scripts/run-node-tests.ts <file|dir> [file|dir...]');
    process.exit(2);
}

const cwd = process.cwd();
const files = targets.flatMap((t) => {
    const resolved = path.resolve(cwd, t);
    try {
        const stat = fs.statSync(resolved);
        if (stat.isFile() && resolved.endsWith('.test.ts')) {
            return [resolved];
        }
        if (stat.isDirectory()) {
            return collectTestFiles(resolved);
        }
    } catch {
        // ignore missing targets
    }
    return [] as string[];
});

if (files.length === 0) {
    console.error(`No '*.test.ts' files found under: ${targets.join(', ')}`);
    process.exit(1);
}

// ─── Global lifecycle management ────────────────────────────────────────────
//
// If we are running integration tests AND WINCCOA_TEST_PROJ is configured,
// start WinCC OA ONCE here, export WINCCOA_EXTERNAL=1 to all child processes
// (so individual test files skip their own start/stop), and tear down once at
// the end.  This avoids the overhead of restarting WinCC OA for every test
// file and prevents seed files being restored multiple times during a run.

const isIntegrationRun = files.some(
    (f) => f.includes(`${path.sep}integration${path.sep}`),
);
const projName = process.env['WINCCOA_TEST_PROJ'];

let globalLifecycle: WinccoaProjectLifecycle | null = null;

(async () => {
    if (isIntegrationRun && projName) {
        const projPath = path.resolve(cwd, 'test', 'fixtures', 'projects', projName);
        globalLifecycle = new WinccoaProjectLifecycle(projPath);

        if (globalLifecycle.isWinccoaAvailable()) {
            console.log(`[runner] Starting WinCC OA lifecycle for project "${projName}"…`);
            await globalLifecycle.start();
            // Signal child processes to skip their own lifecycle management.
            process.env['WINCCOA_EXTERNAL'] = '1';
            console.log(`[runner] WinCC OA ready — WINCCOA_EXTERNAL=1 set for test processes`);
        }
    }

    // Run test files one by one to isolate failures.
    let failed = false;
    try {
        for (const file of files) {
            const args = ['--import', 'tsx', '--test', '--test-force-exit', file];
            const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
            if (result.status !== 0) {
                failed = true;
            }
        }
    } finally {
        if (globalLifecycle !== null && globalLifecycle.isWinccoaAvailable()) {
            // Clear the flag before stopping so the runner's own stop() is fully active.
            delete process.env['WINCCOA_EXTERNAL'];
            console.log('[runner] Stopping WinCC OA…');
            await globalLifecycle.stop();
        }
    }

    process.exit(failed ? 1 : 0);
})().catch((err: unknown) => {
    console.error('[runner] Fatal error:', (err as Error).message ?? err);
    process.exit(1);
});
