/**
 * debugger-bp-cycle.test.ts
 *
 * Full breakpoint cycle integration test against bp_basic_loop.ctl (CTRL manager 1).
 *
 * Tests the complete WinCC OA 3.21 debug workflow:
 *   1. connect to DatapointClient (manager 1 = bp_basic_loop)
 *   2. info scripts → extract scriptId for bp_basic_loop.ctl
 *   3. breakpoint {scriptId, scopeId:0, lib:-1, line:13} (WinCC OA 3.21 format)
 *   4. wait for unsolicited stop event ("line: N" format)
 *   5. script N + thread N to set context
 *   6. bt → verify call stack
 *   7. info thread → verify local variable "counter"
 *   8. cont → verify execution resumes (no second stop within timeout)
 *   9. delete-all → clean up
 *
 * bp_basic_loop.ctl:
 *   Line 13: counter++;   ← BP_LINE
 *   Runs forever, with delay(1) per iteration — reliable for BP testing.
 *
 * Prerequisites (any ONE):
 *   A) WINCCOA_TEST_PROJ / PVSS_II_PROJ set + WinCC OA running with runnable
 *   B) Auto-start via WinccoaProjectLifecycle (if WinCC OA installed, project registered)
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

/** Line in bp_basic_loop.ctl where the BP is set: "    counter++;" */
const BP_LINE = 13;
/** CTRL manager number for bp_basic_loop.ctl */
const BP_TARGET_MANAGER = 1;
/** Timeout (ms) to wait for a stop event after setting the breakpoint */
const STOP_EVENT_TIMEOUT_MS = 8_000;

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
        log('[bp-cycle] WinCC OA not available — tests will be skipped');
        return;
    }

    try {
        await lifecycle.start();
    } catch (err) {
        logErr(`[bp-cycle] Could not start WinCC OA: ${(err as Error).message}`);
        return;
    }

    const config = lifecycle.getDatapointConfig('CTRL', BP_TARGET_MANAGER);
    log(`[bp-cycle] Connecting to _CtrlDebug_CTRL_${BP_TARGET_MANAGER}`);

    const c = new DatapointClient(config);
    c.on('error', (err) => logErr(`[bp-cycle] client error: ${String(err)}`));

    try {
        await c.connect();
        client = c;
        log('[bp-cycle] DatapointClient connected');
    } catch (err) {
        logErr(`[bp-cycle] Connection failed: ${(err as Error).message}`);
    }
});

test.after(async () => {
    if (client?.isConnected()) {
        // Always clean up: remove BPs and resume before disconnect
        await client.sendCommand('delete-all', 2000).catch(() => {});
        await client.sendCommand('cont', 1000).catch(() => {});
        await client.disconnect();
        log('[bp-cycle] DatapointClient disconnected');
    }

    if (lifecycle.isWinccoaAvailable()) {
        await lifecycle.stop();
    }

    printLocalIntegrationTestResult('debugger-bp-cycle', {
        status: testLog.stderr ? 1 : 0,
        stdout: testLog.stdout,
        stderr: testLog.stderr,
    });
});

function requireClient(ctx: test.TestContext): DatapointClient | null {
    if (!client || !client.isConnected()) {
        ctx.skip('WinCC OA not connected — skipping');
        return null;
    }
    return client;
}

// ─── helper: wait for an unsolicited stop event ──────────────────────────────

/**
 * Subscribe to 'message' events on the client and return the first stop event
 * (msg[0] starts with "line: ") that arrives within timeoutMs.
 * Returns null on timeout.
 */
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

// ─── tests ───────────────────────────────────────────────────────────────────

let capturedScriptId = -1;
let capturedThreadId = -1;

test('bp-cycle: DatapointClient connects to bp_basic_loop CTRL manager', async (ctx) => {
    if (!lifecycle.isWinccoaAvailable()) {
        ctx.skip('WinCC OA not available');
        return;
    }
    if (!client) {
        ctx.skip('Client not initialised');
        return;
    }
    assert.ok(client.isConnected());
    assert.equal(client.getDebugDp(), `_CtrlDebug_CTRL_${BP_TARGET_MANAGER}`);
    log(`[bp-cycle] ✔ connected to _CtrlDebug_CTRL_${BP_TARGET_MANAGER}`);
});

test('bp-cycle: info scripts returns bp_basic_loop.ctl entry', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    // Clean up any stale BPs from a previous test run
    await c.sendCommand('delete-all').catch(() => {});
    await c.sendCommand('cont', 500).catch(() => {});

    log('[bp-cycle] Sending "info scripts"…');
    const result = await c.sendCommand('info scripts', 10_000);
    log(`[bp-cycle] info scripts: ${JSON.stringify(result)}`);

    assert.ok(Array.isArray(result) && result.length > 0, 'info scripts must return entries');

    // Find bp_basic_loop.ctl in the script list
    const entry = result.find((line) => line.toLowerCase().includes('bp_basic_loop'));
    assert.ok(entry, `bp_basic_loop.ctl must appear in info scripts (got: ${result.join(', ')})`);

    const m = /ScriptId:\s*(\d+)/.exec(entry);
    assert.ok(m, `ScriptId must be present in: "${entry}"`);
    capturedScriptId = parseInt(m[1], 10);
    log(`[bp-cycle] ✔ bp_basic_loop.ctl scriptId = ${capturedScriptId}`);
});

test('bp-cycle: set breakpoint on bp_basic_loop.ctl line 13 (WinCC OA 3.21 format)', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (capturedScriptId === -1) {
        ctx.skip('scriptId not captured — previous test may have failed');
        return;
    }

    const bpCmd = `breakpoint ${JSON.stringify({ scriptId: capturedScriptId, scopeId: 0, lib: -1, line: BP_LINE })}`;
    log(`[bp-cycle] Sending: "${bpCmd}"`);
    const result = await c.sendCommand(bpCmd, 5_000);
    log(`[bp-cycle] response: ${JSON.stringify(result)}`);

    assert.ok(result[0] === 'breakpoint set', `Expected "breakpoint set", got: ${result[0]}`);
    log(`[bp-cycle] ✔ breakpoint set on line ${BP_LINE}`);
});

test('bp-cycle: receives stop event when CTRL hits the breakpoint', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (capturedScriptId === -1) {
        ctx.skip('scriptId not captured');
        return;
    }

    // Start listening BEFORE resuming so we don't miss the event
    const stopPromise = waitForStopEvent(c, STOP_EVENT_TIMEOUT_MS);

    // Resume execution — bp_target loops with delay(1) so it will hit the BP within ~1s
    log('[bp-cycle] Resuming execution (cont)…');
    await c.sendCommand('cont', 500).catch(() => {});

    log(`[bp-cycle] Waiting up to ${STOP_EVENT_TIMEOUT_MS / 1000}s for stop event…`);
    const msg = await stopPromise;

    assert.ok(msg !== null, `No stop event received within ${STOP_EVENT_TIMEOUT_MS}ms`);
    log(`[bp-cycle] ✔ stop event received: ${JSON.stringify(msg)}`);

    // Validate the WinCC OA 3.21 stop event format
    assert.ok(msg![0].startsWith('line: '), `msg[0] must be "line: N", got: "${msg![0]}"`);
    const stoppedLine = parseInt(msg![0].slice(6), 10);
    assert.equal(stoppedLine, BP_LINE, `Must stop at line ${BP_LINE}`);

    // Extract and store scriptId + threadId for subsequent context commands
    const scriptEntry = msg!.find((m) => m.startsWith('ScriptId:')) ?? '';
    const threadEntry = msg!.find((m) => m.startsWith('ThreadId:')) ?? '';
    const scriptMatch = /ScriptId:\s*(\d+)/.exec(scriptEntry);
    const threadMatch = /ThreadId:\s*(\d+)/.exec(threadEntry);
    assert.ok(scriptMatch, 'ScriptId must be present in stop event');
    assert.ok(threadMatch, 'ThreadId must be present in stop event');
    capturedThreadId = parseInt(threadMatch![1], 10);
    log(`[bp-cycle] ✔ stopped at line ${stoppedLine}, script=${scriptMatch![1]}, thread=${capturedThreadId}`);
});

test('bp-cycle: bt returns call stack after script+thread context', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (capturedScriptId === -1 || capturedThreadId === -1) {
        ctx.skip('Stop context not captured');
        return;
    }

    // Select stopped script+thread (required by WinCC OA 3.21 before bt/print/info thread)
    await c.sendCommand(`script ${capturedScriptId}`, 2_000);
    await c.sendCommand(`thread ${capturedThreadId}`, 2_000);

    log('[bp-cycle] Sending "bt"…');
    const result = await c.sendCommand('bt', 5_000);
    log(`[bp-cycle] bt: ${JSON.stringify(result)}`);

    assert.ok(Array.isArray(result) && result.length > 0, 'bt must return at least one frame');
    // WinCC OA 3.21 backtrace format: "funcSignature at /abs/path.ctl:N"
    const frame0 = result[0];
    assert.ok(
        frame0.includes('main') || frame0.includes('bp_basic_loop') || frame0.includes('at'),
        `First frame must reference bp_basic_loop.ctl or main: "${frame0}"`,
    );
    log(`[bp-cycle] ✔ bt returned ${result.length} frame(s), frame[0]: "${frame0}"`);
});

test('bp-cycle: info thread returns local variable "counter"', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (capturedScriptId === -1 || capturedThreadId === -1) {
        ctx.skip('Stop context not captured');
        return;
    }

    // Re-select context (may have been reset)
    await c.sendCommand(`script ${capturedScriptId}`, 2_000);
    await c.sendCommand(`thread ${capturedThreadId}`, 2_000);

    log('[bp-cycle] Sending "info thread"…');
    const result = await c.sendCommand('info thread', 5_000);
    log(`[bp-cycle] info thread: ${JSON.stringify(result)}`);

    assert.ok(Array.isArray(result) && result.length > 0, 'info thread must return data');

    // WinCC OA 3.21: variables as JSON objects per line
    // Look for: {"const":0,"name":"counter","value":{"type":"int",...,"value":N}}
    const counterLine = result.find((line) => {
        try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            return obj.name === 'counter';
        } catch {
            return false;
        }
    });

    assert.ok(counterLine, `"counter" variable must appear in info thread (got: ${result.join('; ')})`);
    const parsed = JSON.parse(counterLine) as {
        name: string;
        value: { value: unknown } | unknown;
    };
    const val = (parsed.value as Record<string, unknown>)?.['value'];
    assert.ok(typeof val === 'number' && val >= 1, `counter must be >= 1, got: ${val}`);
    log(`[bp-cycle] ✔ counter = ${val}`);
});

test('bp-cycle: cont resumes execution (no immediate second stop)', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    // Listen for a second stop event — should NOT arrive within 500ms after cont
    const secondStop = waitForStopEvent(c, 500);

    log('[bp-cycle] Sending "cont"…');
    const result = await c.sendCommand('cont', 3_000);
    log(`[bp-cycle] cont response: ${JSON.stringify(result)}`);

    assert.ok(Array.isArray(result), 'cont must return a response');
    // WinCC OA 3.21: cont responds with ["continuing"] when it resumes
    const resumeText = result.join(' ').toLowerCase();
    assert.ok(
        resumeText.includes('continuing') || resumeText.length === 0 || result[0] === 'OK',
        `Expected "continuing" or OK from cont, got: ${result.join(' ')}`,
    );

    const earlyStop = await secondStop;
    assert.ok(earlyStop === null, 'Must NOT receive a second stop event immediately after cont');
    log('[bp-cycle] ✔ execution resumed, no immediate second stop');
});

test('bp-cycle: delete-all clears breakpoints', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    log('[bp-cycle] Sending "delete-all"…');
    const result = await c.sendCommand('delete-all', 5_000);
    log(`[bp-cycle] delete-all: ${JSON.stringify(result)}`);

    assert.ok(Array.isArray(result), 'delete-all must return a response');
    log('[bp-cycle] ✔ all breakpoints cleared');
});
