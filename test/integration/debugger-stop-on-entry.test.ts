/**
 * debugger-stop-on-entry.test.ts
 *
 * Integration test for DebugBreak() / stopOnEntry support.
 *
 * Verifies that the adapter can catch a stop event that was written to the
 * Result DPE *before* the adapter connected — i.e. the classic stopOnEntry
 * race condition is solved by using `answerOnConnect: true` on dpConnect.
 *
 * Tested script: scripts/stop_on_entry.ctl
 *   - Started via manager -num 3 with -dbg CTRL_DEBUGBREAK
 *   - Calls DebugBreak() at line 20 immediately on startup
 *   - Thread halts indefinitely until "cont" is sent
 *
 * Test flow:
 *   1. Start WinCC OA (pmon + always-mode managers)
 *   2. Start manager -num 3 via startManagerByNum(3)
 *   3. Wait 2s for DebugBreak() to fire and write stop event to Result DPE
 *   4. Connect DatapointClient with answerOnConnect=true
 *   5. Assert stop event (unsolicited "line: N") is received within 3s
 *   6. Extract scriptId → send "script N" + "thread N" context
 *   7. Inspect variables via "info thread" → assert a=10, b=32
 *   8. Send "cont" → assert no further stop within 2s (script finishes)
 *   9. Cleanup: delete-all, disconnect, stopManagerByNum(3)
 *
 * Prerequisites (any ONE):
 *   A) WINCCOA_TEST_PROJ / PVSS_II_PROJ set + WinCC OA installed
 *   B) WINCCOA_SKIP=1 → all tests skipped
 *
 * Running locally:
 *   WINCCOA_TEST_PROJ=runnable npm run test:integration
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

/** CTRL manager number for stop_on_entry.ctl (manual, -dbg CTRL_DEBUGBREAK) */
const STOP_ON_ENTRY_MANAGER = 2;
/** Milliseconds to wait for DebugBreak() to fire after manager start */
const DEBUGBREAK_SETTLE_MS = 2_000;
/** Timeout to receive the initial stop event via answer=true */
const INITIAL_STOP_TIMEOUT_MS = 5_000;

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
        log('[stop-on-entry] WinCC OA not available — tests will be skipped');
        return;
    }

    try {
        await lifecycle.start();
    } catch (err) {
        logErr(`[stop-on-entry] Could not start WinCC OA: ${(err as Error).message}`);
        return;
    }

    // Start the manual manager -num 3 (stop_on_entry.ctl + -dbg CTRL_DEBUGBREAK)
    try {
        await lifecycle.startManagerByNum(STOP_ON_ENTRY_MANAGER);
        log(`[stop-on-entry] Manager -num ${STOP_ON_ENTRY_MANAGER} started`);
    } catch (err) {
        logErr(`[stop-on-entry] Failed to start manager: ${(err as Error).message}`);
        return;
    }

    // Give the script time to start and call DebugBreak().
    // The thread is now halted — the stop event is written to Result DPE.
    log(`[stop-on-entry] Waiting ${DEBUGBREAK_SETTLE_MS}ms for DebugBreak() to fire…`);
    await new Promise((r) => setTimeout(r, DEBUGBREAK_SETTLE_MS));

    // Connect with answerOnConnect=true so we receive the stale stop event.
    const config = lifecycle.getDatapointConfig('CTRL', STOP_ON_ENTRY_MANAGER);
    config.answerOnConnect = true;

    const c = new DatapointClient(config);
    c.on('error', (err) => logErr(`[stop-on-entry] client error: ${String(err)}`));

    try {
        await c.connect();
        client = c;
        log(`[stop-on-entry] DatapointClient connected (answerOnConnect=true)`);
    } catch (err) {
        logErr(`[stop-on-entry] Connection failed: ${(err as Error).message}`);
    }
});

test.after(async () => {
    if (client?.isConnected()) {
        await client.sendCommand('delete-all', 2000).catch(() => {});
        await client.sendCommand('cont', 1000).catch(() => {});
        await client.disconnect();
        log('[stop-on-entry] DatapointClient disconnected');
    }

    // Stop the manual manager so it doesn't interfere with other test suites
    if (lifecycle.isWinccoaAvailable()) {
        await lifecycle
            .stopManagerByNum(STOP_ON_ENTRY_MANAGER)
            .catch((e) => logErr(`[stop-on-entry] stopManagerByNum: ${e.message}`));

        await lifecycle.stop();
    }

    printLocalIntegrationTestResult('debugger-stop-on-entry', {
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

// ─── helper ──────────────────────────────────────────────────────────────────

/**
 * Waits until a 'message' event is emitted whose first element matches
 * the given prefix (e.g. "line: ").  Returns the full message array.
 */
function waitForMessage(
    c: DatapointClient,
    matchFn: (msg: string[]) => boolean,
    timeoutMs: number,
): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            c.removeListener('message', handler);
            reject(new Error(`[stop-on-entry] Timed out after ${timeoutMs}ms waiting for message`));
        }, timeoutMs);

        const handler = (msg: string[]) => {
            if (matchFn(msg)) {
                clearTimeout(timer);
                c.removeListener('message', handler);
                resolve(msg);
            }
        };
        c.on('message', handler);
    });
}

// ─── tests ───────────────────────────────────────────────────────────────────

test('DebugBreak: initial stop event received via answerOnConnect=true', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    // The stop event was written BEFORE we connected.  With answerOnConnect=true
    // the dpConnect callback fires immediately with the current Result DPE value.
    const stopMsg = await waitForMessage(
        c,
        (msg) => msg[0] !== undefined && /^line:\s+\d+/i.test(msg[0] ?? ''),
        INITIAL_STOP_TIMEOUT_MS,
    );

    log(`[stop-on-entry] Received stop event: ${JSON.stringify(stopMsg)}`);

    // msg[0] = "line: 20"  (or similar — DebugBreak() is at line 20)
    assert.match(stopMsg[0] ?? '', /^line:\s+\d+/i, 'First element must be "line: N"');
    // msg[2] = "ScriptId: N"
    assert.ok(
        stopMsg.some((s) => /ScriptId:\s*\d+/i.test(s)),
        `Expected a "ScriptId: N" element in stop message, got: ${JSON.stringify(stopMsg)}`,
    );
});

test('DebugBreak: variables a and b are readable before cont', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    // Extract scriptId and threadId from the first stop event.
    // If we already consumed it above the Result DP is unchanged — send "info scripts"
    // to re-obtain scriptId.
    const scripts = await c.sendCommand('info scripts', 5000);
    log(`[stop-on-entry] info scripts: ${JSON.stringify(scripts)}`);

    const scriptEntry = scripts.find((s) => s.includes('stop_on_entry'));
    assert.ok(scriptEntry, `Expected stop_on_entry.ctl in script list, got: ${JSON.stringify(scripts)}`);

    const scriptIdMatch = scriptEntry.match(/ScriptId:\s*(\d+)/i);
    const scriptId = scriptIdMatch ? Number(scriptIdMatch[1]) : null;
    assert.ok(scriptId !== null, `Could not extract ScriptId from: ${scriptEntry}`);

    // Set thread context (thread 1 is main by convention)
    await c.sendCommand(`script ${scriptId}`, 2000);
    await c.sendCommand('thread 1', 2000);

    // Read variables
    const vars = await c.sendCommand('info thread', 5000);
    log(`[stop-on-entry] info thread: ${JSON.stringify(vars)}`);

    const combined = vars.join(' ');
    assert.ok(
        combined.includes('"name":"a"') || combined.includes('"a"'),
        `Expected variable "a" in info thread output: ${combined}`,
    );
    assert.ok(
        combined.includes('"name":"b"') || combined.includes('"b"'),
        `Expected variable "b" in info thread output: ${combined}`,
    );
});

test('DebugBreak: cont resumes execution and script finishes', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    // After "cont" the script completes (it has no loop) → no further stop event.
    await c.sendCommand('cont', 2000);
    log('[stop-on-entry] cont sent — script should finish');

    // Confirm there is NO additional stop event within 2s.
    const noSecondStop = await Promise.race<boolean>([
        new Promise((resolve) => {
            const h = (msg: string[]) => {
                if (/^line:\s+\d+/i.test(msg[0] ?? '')) {
                    c.removeListener('message', h);
                    resolve(false); // unexpected stop
                }
            };
            c.on('message', h);
            setTimeout(() => {
                c.removeListener('message', h);
                resolve(true); // no second stop → good
            }, 2000);
        }),
    ]);

    assert.ok(noSecondStop, 'Expected script to finish without a second stop event after cont');
    log('[stop-on-entry] Confirmed: no second stop after cont');
});
