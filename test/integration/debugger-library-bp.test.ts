/**
 * debugger-library-bp.test.ts
 *
 * Integration tests for breakpoints in #uses library files.
 *
 * Problem being tested:
 *   WinCC OA 3.21 only lists a library file in `info scripts` once a function
 *   from it has an active call frame.  When the Debug Adapter sets breakpoints
 *   in libs/debugger_lib.ctl at startup (via setBreakPointsRequest), the library
 *   is NOT yet visible in `info scripts` — so all breakpoints in it are returned
 *   as unverified (greyed-out in VS Code).
 *
 *   The adapter must:
 *     1. Detect that the script ID cannot be found → store as "pending"
 *     2. After the FIRST stop event (which occurs in the main script), retry
 *        `info scripts` → by now the library IS listed (its function is on the stack)
 *     3. Set the breakpoints and notify VS Code via BreakpointEvent('changed')
 *
 * Test flow (call_library_function.ctl, manager -num 3):
 *   1. start WinCC OA + manager -num 3
 *   2. connect DatapointClient (system = project name)
 *   3. call `info scripts` → debugger_lib.ctl MUST NOT appear yet
 *   4. attempt to find scriptId for debugger_lib.ctl → expect -1
 *   5. set breakpoint in main script (call_library_function.ctl line 13) → must verify OK
 *   6. wait for stop event at line 13
 *   7. call `info scripts` again → debugger_lib.ctl MUST now appear
 *   8. set breakpoint in library (debugger_lib.ctl line 7) → must respond "breakpoint set"
 *   9. cont → wait for stop in library (line 7, different file)
 *  10. cleanup
 *
 * Prerequisites (any ONE):
 *   A) WINCCOA_TEST_PROJ / PVSS_II_PROJ set + WinCC OA running with runnable
 *   B) Auto-start via WinccoaProjectLifecycle
 *   C) WINCCOA_SKIP=1 → all tests skipped
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatapointClient } from '../../src/connection/DatapointClient.js';
import { WinccoaProjectLifecycle } from '../helpers/WinccoaProjectLifecycle.js';
import { printLocalIntegrationTestResult } from '../helpers/integration-teardown.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── constants ───────────────────────────────────────────────────────────────

/** CTRL manager number for call_library_function.ctl */
const LIBRARY_MANAGER = 3;
/** Line in call_library_function.ctl where add_two_integers() is called (first stop target) */
const BP_MAIN_LINE = 13;
/** Line in libs/debugger_lib.ctl inside add_two_integers() — must be set AFTER first stop */
const BP_LIB_LINE = 7;
/** Timeout to wait for a stop event */
const STOP_TIMEOUT_MS = 8_000;

// ─── lifecycle ───────────────────────────────────────────────────────────────

const PROJ_PATH = path.resolve(__dirname, '../fixtures/projects/runnable');
const lifecycle = new WinccoaProjectLifecycle(PROJ_PATH);
let client: DatapointClient | null = null;
const testLog = { stdout: '', stderr: '' };

function log(msg: string) {
    testLog.stdout += msg + '\n';
    console.log(msg);
}
function logErr(msg: string) {
    testLog.stderr += msg + '\n';
    console.error(msg);
}

// ─── setup/teardown ──────────────────────────────────────────────────────────

test.before(async () => {
    if (!lifecycle.isWinccoaAvailable()) {
        log('[library-bp] WinCC OA not available — tests will be skipped');
        return;
    }

    try {
        await lifecycle.start();
    } catch (err) {
        logErr(`[library-bp] Could not start WinCC OA: ${(err as Error).message}`);
        return;
    }

    try {
        await lifecycle.startManagerByNum(LIBRARY_MANAGER);
        log(`[library-bp] Manager -num ${LIBRARY_MANAGER} started`);
        // Give the script time to begin its event loop
        await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
        logErr(`[library-bp] Failed to start manager: ${(err as Error).message}`);
        return;
    }

    const config = lifecycle.getDatapointConfig('CTRL', LIBRARY_MANAGER);
    const c = new DatapointClient(config);
    c.on('error', (err) => logErr(`[library-bp] client error: ${String(err)}`));

    try {
        await c.connect();
        client = c;
        log('[library-bp] DatapointClient connected');
    } catch (err) {
        logErr(`[library-bp] Connection failed: ${(err as Error).message}`);
    }
});

test.after(async () => {
    if (client?.isConnected()) {
        await client.sendCommand('delete-all', 2000).catch(() => {});
        await client.sendCommand('cont', 1000).catch(() => {});
        await client.disconnect();
        log('[library-bp] DatapointClient disconnected');
    }

    if (lifecycle.isWinccoaAvailable()) {
        await lifecycle.stopManagerByNum(LIBRARY_MANAGER).catch(() => {});
        await lifecycle.stop();
    }

    printLocalIntegrationTestResult('debugger-library-bp', {
        status: testLog.stderr ? 1 : 0,
        stdout: testLog.stdout,
        stderr: testLog.stderr,
    });
});

function requireClient(ctx: test.TestContext): DatapointClient | null {
    if (!client?.isConnected()) {
        ctx.skip('WinCC OA not connected — skipping');
        return null;
    }
    return client;
}

/** Wait for an unsolicited stop event (msg[0] starts with "line: ") */
function waitForStopEvent(c: DatapointClient, timeoutMs: number): Promise<string[] | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            c.removeListener('message', handler);
            resolve(null);
        }, timeoutMs);
        const handler = (msg: string[]) => {
            if (msg[0]?.startsWith('line: ')) {
                clearTimeout(timer);
                c.removeListener('message', handler);
                resolve(msg);
            }
        };
        c.on('message', handler);
    });
}

function findScriptId(result: string[], basename: string): number {
    const lower = basename.toLowerCase();
    for (const line of result) {
        if (!line.includes('ScriptId:')) continue;
        if (line.toLowerCase().includes(lower)) {
            const m = /ScriptId:\s*(\d+)/.exec(line);
            if (m) return parseInt(m[1], 10);
        }
    }
    return -1;
}

// ─── shared state ────────────────────────────────────────────────────────────

let mainScriptId = -1;
let libScriptId = -1;
let capturedThreadId = 0;

// ─── tests ───────────────────────────────────────────────────────────────────

test('library-bp: connected to call_library_function CTRL manager', async (ctx) => {
    if (!lifecycle.isWinccoaAvailable()) { ctx.skip('WinCC OA not available'); return; }
    if (!client) { ctx.skip('Client not initialised'); return; }
    assert.ok(client.isConnected());
    log(`[library-bp] ✔ connected to _CtrlDebug_CTRL_${LIBRARY_MANAGER}`);
});

test('library-bp: debugger_lib.ctl NOT in info scripts before first call', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    // Clean any stale state
    await c.sendCommand('delete-all').catch(() => {});
    await c.sendCommand('cont', 500).catch(() => {});

    log('[library-bp] calling info scripts before any function entry…');
    const result = await c.sendCommand('info scripts', 5_000);
    log(`[library-bp] info scripts: ${JSON.stringify(result)}`);

    // The main script must be listed (it is running)
    const mainEntry = result.find((l) => l.toLowerCase().includes('call_library_function'));
    assert.ok(
        mainEntry,
        `call_library_function.ctl must appear in info scripts (got: ${result.join(', ')})`,
    );
    const m = /ScriptId:\s*(\d+)/.exec(mainEntry);
    assert.ok(m, `ScriptId must be present: "${mainEntry}"`);
    mainScriptId = parseInt(m[1], 10);

    // The library must NOT be listed yet — no function from it has been called
    const libId = findScriptId(result, 'debugger_lib');
    assert.equal(
        libId,
        -1,
        `debugger_lib.ctl must NOT be in info scripts before first function call, got id=${libId}`,
    );
    log('[library-bp] ✔ debugger_lib.ctl not yet visible in info scripts (expected)');
});

test('library-bp: breakpoint set in main script verifies immediately', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (mainScriptId === -1) {
        ctx.skip('mainScriptId not captured');
        return;
    }

    const bpCmd = `breakpoint ${JSON.stringify({ scriptId: mainScriptId, scopeId: 0, lib: -1, line: BP_MAIN_LINE })}`;
    log(`[library-bp] setting main-script BP: ${bpCmd}`);
    const result = await c.sendCommand(bpCmd, 5_000);
    log(`[library-bp] BP response: ${JSON.stringify(result)}`);

    assert.equal(result[0], 'breakpoint set',
        `Main-script BP must verify immediately, got: "${result[0]}"`);
    log(`[library-bp] ✔ main BP verified at line ${BP_MAIN_LINE}`);
});

test('library-bp: stop event arrives at main-script BP (line 19)', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    const stopPromise = waitForStopEvent(c, STOP_TIMEOUT_MS);
    log('[library-bp] resuming execution…');
    await c.sendCommand('cont', 500).catch(() => {});

    const msg = await stopPromise;
    assert.ok(msg !== null, `No stop event within ${STOP_TIMEOUT_MS}ms`);

    const line = parseInt(msg![0].slice(6), 10);
    assert.equal(line, BP_MAIN_LINE, `Must stop at main-script line ${BP_MAIN_LINE}, got ${line}`);

    const threadEntry = msg!.find((s) => s.startsWith('ThreadId:')) ?? '';
    const threadM = /ThreadId:\s*(\d+)/.exec(threadEntry);
    assert.ok(threadM, 'ThreadId must be in stop event');
    capturedThreadId = parseInt(threadM![1], 10);

    log(`[library-bp] ✔ stopped at main line ${line}, thread=${capturedThreadId}`);
});

test('library-bp: debugger_lib.ctl NOW appears in info scripts after first stop', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    // Select context required for the assertion to be meaningful
    await c.sendCommand(`script ${mainScriptId}`, 2_000);
    await c.sendCommand(`thread ${capturedThreadId}`, 2_000);

    log('[library-bp] calling info scripts after first stop (library should now appear)…');
    const result = await c.sendCommand('info scripts', 5_000);
    log(`[library-bp] info scripts: ${JSON.stringify(result)}`);

    libScriptId = findScriptId(result, 'debugger_lib');
    assert.notEqual(
        libScriptId,
        -1,
        `debugger_lib.ctl MUST appear in info scripts after first stop (got: ${result.join(', ')})`,
    );
    log(`[library-bp] ✔ debugger_lib.ctl now visible with scriptId=${libScriptId}`);
});

test('library-bp: breakpoint in library sets successfully after first stop', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (libScriptId === -1) {
        ctx.skip('libScriptId not found — previous test failed');
        return;
    }

    const bpCmd = `breakpoint ${JSON.stringify({ scriptId: libScriptId, scopeId: 0, lib: -1, line: BP_LIB_LINE })}`;
    log(`[library-bp] setting library BP: ${bpCmd}`);
    const result = await c.sendCommand(bpCmd, 5_000);
    log(`[library-bp] library BP response: ${JSON.stringify(result)}`);

    assert.equal(
        result[0],
        'breakpoint set',
        `Library BP must verify once library is in info scripts, got: "${result[0]}"`,
    );
    log(`[library-bp] ✔ library BP verified at debugger_lib.ctl:${BP_LIB_LINE}`);
});

test('library-bp: stop event arrives at library BP (debugger_lib.ctl:7)', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (libScriptId === -1) {
        ctx.skip('libScriptId not found');
        return;
    }

    const stopPromise = waitForStopEvent(c, STOP_TIMEOUT_MS);
    log('[library-bp] resuming to reach library BP…');
    await c.sendCommand('cont', 500).catch(() => {});

    const msg = await stopPromise;
    assert.ok(msg !== null, `No stop event within ${STOP_TIMEOUT_MS}ms after cont`);

    const line = parseInt(msg![0].slice(6), 10);
    assert.equal(line, BP_LIB_LINE,
        `Must stop at library line ${BP_LIB_LINE} (inside add_two_integers), got ${line}`);

    // The ScriptId in the stop event must match the library, not the main script
    const scriptEntry = msg!.find((s) => s.startsWith('ScriptId:')) ?? '';
    const scriptM = /ScriptId:\s*(\d+)/.exec(scriptEntry);
    assert.ok(scriptM, 'ScriptId must be in stop event');
    const stopScriptId = parseInt(scriptM![1], 10);
    assert.equal(stopScriptId, libScriptId,
        `Stop event must reference library scriptId=${libScriptId}, got ${stopScriptId}`);

    log(`[library-bp] ✔ stopped at library line ${line}, scriptId=${stopScriptId}`);
});
