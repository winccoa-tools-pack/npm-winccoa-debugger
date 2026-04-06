/**
 * debugger-spurious-stops.test.ts
 *
 * Integration tests for spurious stop events caused by `script N` / `thread N`
 * context commands.
 *
 * Problem being tested:
 *   Before the fix in DatapointClient.ts, EVERY command sent to the Debug-DP
 *   (including context queries like `script N` or `thread N`) triggered a
 *   DatapointClient 'message' event when the response looked like a stop event.
 *   The Debug Adapter uses these context commands inside stackTraceRequest and
 *   variablesRequest — both of which VS Code calls multiple times per stop.
 *
 *   Consequence: VS Code's Continue button had to be pressed 3 × to actually
 *   resume execution because the adapter re-issued a StoppedEvent for each
 *   spurious 'message' emission.
 *
 * Test flow (bp_basic_loop.ctl, manager -num 1):
 *   1. Connect to manager 1 (bp_basic_loop.ctl — always-running endless loop)
 *   2. Clear any stale BPs, resume
 *   3. Capture scriptId via `info scripts`
 *   4. Set ONE breakpoint at BP_LINE (line 13 = counter++)
 *   5. cont → wait for genuine stop at BP_LINE
 *   6. Issue context commands (`script N` + `thread N`) that return stop-like data
 *   7. Assert these context commands emit ZERO spurious 'message' events
 *   8. Send ONE `cont`
 *   9. Wait for the next genuine stop (next loop iteration)
 *  10. Assert exactly ONE 'message' event arrived (no spurious ones)
 *
 * Expected outcome WITHOUT the fix:  ≥ 1 spurious 'message' events per context cmd
 * Expected outcome WITH the fix:     0 spurious events; single cont reaches next stop
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

/** CTRL manager running bp_basic_loop.ctl (manager -num 1, always-running endless loop) */
const BP_MANAGER = 1;
/**
 * Breakpoint line in bp_basic_loop.ctl.
 * Line 13 = `counter++` in the while loop;
 * must match what WinCC OA reports in `info scripts` (same value as bp-cycle tests).
 */
const BP_LINE = 13;

/** How long to wait for a genuine stop event */
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
        log('[spurious-stops] WinCC OA not available — tests will be skipped');
        return;
    }

    try {
        await lifecycle.start();
        // Manager -num 1 (bp_basic_loop.ctl) is configured as 'always' in config/progs
        // and is started automatically by lifecycle.start().
        await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
        logErr(`[spurious-stops] Could not start WinCC OA: ${(err as Error).message}`);
        return;
    }

    const config = lifecycle.getDatapointConfig('CTRL', BP_MANAGER);
    const c = new DatapointClient(config);
    c.on('error', (err) => logErr(`[spurious-stops] client error: ${String(err)}`));

    try {
        await c.connect();
        client = c;
        log('[spurious-stops] DatapointClient connected');
    } catch (err) {
        logErr(`[spurious-stops] Connection failed: ${(err as Error).message}`);
    }
});

test.after(async () => {
    if (client?.isConnected()) {
        await client.sendCommand('delete-all', 2000).catch(() => {});
        await client.sendCommand('cont', 1000).catch(() => {});
        await client.disconnect();
        log('[spurious-stops] DatapointClient disconnected');
    }

    if (lifecycle.isWinccoaAvailable()) {
        await lifecycle.stop();
    }

    printLocalIntegrationTestResult('debugger-spurious-stops', {
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

// ─── shared state ────────────────────────────────────────────────────────────

let mainScriptId = -1;
let capturedThreadId = 0;

// ─── tests ───────────────────────────────────────────────────────────────────

test('spurious-stops: connected to bp_basic_loop CTRL manager', async (ctx) => {
    if (!lifecycle.isWinccoaAvailable()) { ctx.skip('WinCC OA not available'); return; }
    if (!client) { ctx.skip('Client not initialised'); return; }
    assert.ok(client.isConnected());
    log(`[spurious-stops] ✔ connected to _CtrlDebug_CTRL_${BP_MANAGER}`);
});

test('spurious-stops: capture scriptId from info scripts', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    await c.sendCommand('delete-all').catch(() => {});
    await c.sendCommand('cont', 500).catch(() => {});

    const result = await c.sendCommand('info scripts', 5_000);
    log(`[spurious-stops] info scripts: ${JSON.stringify(result)}`);

    const mainEntry = result.find((l) => l.toLowerCase().includes('bp_basic_loop'));
    assert.ok(mainEntry, `bp_basic_loop.ctl must appear in info scripts (got: ${result.join(', ')})`);
    const m = /ScriptId:\s*(\d+)/.exec(mainEntry);
    assert.ok(m, `ScriptId must be present in: "${mainEntry}"`);
    mainScriptId = parseInt(m[1], 10);
    log(`[spurious-stops] ✔ bp_basic_loop.ctl scriptId = ${mainScriptId}`);
});

test('spurious-stops: breakpoint set at BP_LINE verifies immediately', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (mainScriptId === -1) { ctx.skip('scriptId not captured'); return; }

    const bpCmd = `breakpoint ${JSON.stringify({ scriptId: mainScriptId, scopeId: 0, lib: -1, line: BP_LINE })}`;
    const result = await c.sendCommand(bpCmd, 5_000);
    assert.equal(result[0], 'breakpoint set',
        `BP at line ${BP_LINE} must verify, got: "${result[0]}"`);
    log(`[spurious-stops] ✔ BP set at line ${BP_LINE}`);
});

test('spurious-stops: first stop arrives at BP_LINE', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (mainScriptId === -1) { ctx.skip('scriptId not captured'); return; }

    const stopPromise = waitForStopEvent(c, STOP_TIMEOUT_MS);
    await c.sendCommand('cont', 500).catch(() => {});
    const msg = await stopPromise;

    assert.ok(msg !== null, `No stop within ${STOP_TIMEOUT_MS}ms`);
    const line = parseInt(msg![0].slice(6), 10);
    assert.equal(line, BP_LINE, `Must stop at BP_LINE=${BP_LINE}, got ${line}`);

    const threadEntry = msg!.find((s) => s.startsWith('ThreadId:')) ?? '';
    const threadM = /ThreadId:\s*(\d+)/.exec(threadEntry);
    assert.ok(threadM, 'ThreadId must be in stop event');
    capturedThreadId = parseInt(threadM![1], 10);

    log(`[spurious-stops] ✔ first stop at line ${line}, thread=${capturedThreadId}`);
});

test('spurious-stops: context commands do NOT emit spurious message events', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (mainScriptId === -1 || capturedThreadId === 0) {
        ctx.skip('state not ready');
        return;
    }

    // Issue the same context commands that the Debug Adapter uses in
    // stackTraceRequest / variablesRequest.  These must NOT trigger 'message'.
    const spuriousMessages: string[][] = [];
    const spuriousListener = (msg: string[]) => {
        // Only collect stop-like messages (what was wrongly emitted before the fix)
        if (msg[0]?.startsWith('line: ')) {
            spuriousMessages.push(msg);
        }
    };

    c.on('message', spuriousListener);

    log('[spurious-stops] sending context commands (script + thread)…');
    await c.sendCommand(`script ${mainScriptId}`, 2_000);
    await c.sendCommand(`thread ${capturedThreadId}`, 2_000);

    // Short wait to let any spurious events propagate
    await new Promise((r) => setTimeout(r, 500));
    c.removeListener('message', spuriousListener);

    log(`[spurious-stops] spurious stop messages from context commands: ${spuriousMessages.length}`);
    assert.equal(
        spuriousMessages.length,
        0,
        `Context commands (script/thread) must NOT emit stop-like 'message' events. ` +
        `Got ${spuriousMessages.length} spurious event(s): ${JSON.stringify(spuriousMessages)}`,
    );
    log('[spurious-stops] ✔ zero spurious events from context commands');
});

test('spurious-stops: single cont reaches next loop iteration at BP_LINE, no extra stops', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (mainScriptId === -1) { ctx.skip('scriptId not captured'); return; }

    // Collect ALL stop-like 'message' events after we send cont.
    // With the bug:  context commands (script N / thread N) would emit extra
    //                'message' events here, making allMessages.length > 1.
    // Without bug:   only the genuine next-iteration stop arrives → length == 1.
    const allMessages: string[][] = [];
    const allListener = (msg: string[]) => {
        if (msg[0]?.startsWith('line: ')) {
            allMessages.push(msg);
        }
    };
    c.on('message', allListener);

    const stopPromise = waitForStopEvent(c, STOP_TIMEOUT_MS);

    log('[spurious-stops] sending ONE cont — expecting next-iteration stop at BP_LINE…');
    await c.sendCommand('cont', 500).catch(() => {});

    // Wait for the genuine next stop
    const msg = await stopPromise;
    c.removeListener('message', allListener);

    assert.ok(msg !== null, `No stop within ${STOP_TIMEOUT_MS}ms after single cont`);

    // Must land at the same BP_LINE in the next loop iteration
    const line = parseInt(msg![0].slice(6), 10);
    assert.equal(
        line,
        BP_LINE,
        `ONE cont must reach next iteration BP_LINE=${BP_LINE}, got ${line}.`,
    );

    // Exactly ONE stop event must have arrived (no spurious extra events)
    log(`[spurious-stops] total stop events received after cont: ${allMessages.length}`);
    assert.equal(
        allMessages.length,
        1,
        `Expected exactly 1 stop event (next iteration at BP_LINE=${BP_LINE}), got ${allMessages.length}: ` +
        `${JSON.stringify(allMessages.map((m) => m[0]))}. ` +
        `Extra events indicate spurious 'message' emissions from context commands (3×-press bug).`,
    );

    log(`[spurious-stops] ✔ single cont → next iteration at line ${line}, exactly 1 event`);
});

test('spurious-stops: cleanup delete-all succeeds', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    const result = await c.sendCommand('delete-all', 3_000);
    log(`[spurious-stops] delete-all result: ${JSON.stringify(result)}`);
    // Basic sanity — as long as no exception is thrown the cleanup worked
    assert.ok(Array.isArray(result));
    log('[spurious-stops] ✔ cleanup OK');
});
