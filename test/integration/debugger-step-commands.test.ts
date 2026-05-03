/**
 * debugger-step-commands.test.ts
 *
 * Integration tests for WinCC OA CTRL debugger step and pause commands against
 * the real WinCC OA runtime.
 *
 * Commands under test:
 *   - `next`   (step-over)  — moves to next source line without entering calls
 *   - `step`   (step-into)  — enters the function called on the current line
 *   - `finish` (step-out)   — runs until current function returns to its caller
 *   - `b`      (pause)      — breaks a running script at the current position
 *   - `print <var>`         — returns the current value of a local variable
 *   - `bt` 3-frame          — verifies deep call-stack backtrace format
 *
 * Test script: callstack_depth3.ctl  (CTRL manager -num 4, mode: always)
 *
 * Call chain:
 *   main() → compute_outer(n) → compute_inner(n, 3) → multiply_and_add(n, 3, 1)
 *
 * Key line numbers (callstack_depth3.ctl):
 *   Line 19: int result = x * factor + z;          ← inside multiply_and_add   (BP A)
 *   Line 20: return result;                         ← step-over target from line 19
 *   Line 25: int partial = multiply_and_add(…);    ← first stmt in compute_inner
 *   Line 26: return partial;                        ← step-out landing range
 *   Line 31: int value = compute_inner(n, 3);       ← compute_outer call  (BP B / step-in source)
 *
 * Test phases:
 *   Phase A — stop at multiply_and_add line 19 (BP A):
 *     [A0] Set BP, cont, capture first stop
 *     [A1] bt with ≥ 3 frames (multiply_and_add, compute_inner, compute_outer)
 *     [A2] print x  → returns a positive integer
 *     [A3] next     → stops at line 20  (step-over)
 *     [A4] finish   → stops in compute_inner lines 25–26  (step-out)
 *
 *   Phase B — stop at compute_outer line 31 (BP B):
 *     [B0] Set BP at line 31, cont → stop at line 31
 *     [B1] step     → stops inside compute_inner lines 23–27  (step-into)
 *
 *   Phase C — pause a running script:
 *     [C0] b        → stop event received at any valid line  (pause/break)
 *
 * Prerequisites (any ONE):
 *   A) WINCCOA_TEST_PROJ / PVSS_II_PROJ set + WinCC OA running with "runnable" project
 *   B) Auto-start via WinccoaProjectLifecycle (WinCC OA installed, project registered)
 *   C) WINCCOA_SKIP=1  → all tests skipped
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

/** CTRL manager for callstack_depth3.ctl (always-running) */
const STACK_MANAGER = 4;

// Line numbers in callstack_depth3.ctl (verified with cat -n)
/** First executable stmt in multiply_and_add() — primary BP */
const MULTIPLY_LINE = 19;        // int result = x * factor + z
/** Next line after MULTIPLY_LINE — step-over landing */
const MULTIPLY_NEXT_LINE = 20;  // return result
/** compute_inner body start (first executable stmt) */
const COMPUTE_INNER_FIRST = 25;  // int partial = multiply_and_add(n, factor, 1)
/** compute_inner body end (last stmt before closing brace) */
const COMPUTE_INNER_LAST = 26;   // return partial
/** compute_outer call-site — step-into source (Phase B) */
const COMPUTE_OUTER_CALL_LINE = 31; // int value = compute_inner(n, 3)

/** Timeout for step-command stop events (should arrive within ms, generous budget) */
const STEP_STOP_TIMEOUT_MS = 5_000;
/** Timeout for BP-triggered stop events (loop runs with delay(1)) */
const BP_STOP_TIMEOUT_MS = 8_000;

// ─── lifecycle ───────────────────────────────────────────────────────────────

const PROJ_PATH = path.resolve(__dirname, '../fixtures/projects/runnable');
const lifecycle = new WinccoaProjectLifecycle(PROJ_PATH);
let client: DatapointClient | null = null;
const testLog = { stdout: '', stderr: '' };

function log(msg: string) { testLog.stdout += msg + '\n'; console.log(msg); }
function logErr(msg: string) { testLog.stderr += msg + '\n'; console.error(msg); }

// ─── setup / teardown ────────────────────────────────────────────────────────

test.before(async () => {
    if (!lifecycle.isWinccoaAvailable()) {
        log('[step-commands] WinCC OA not available — tests will be skipped');
        return;
    }

    try {
        await lifecycle.start();
        // Give callstack_depth3.ctl (manager -num 4, always) time to begin its loop
        await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
        logErr(`[step-commands] Could not start WinCC OA: ${(err as Error).message}`);
        return;
    }

    const config = lifecycle.getDatapointConfig('CTRL', STACK_MANAGER);
    const c = new DatapointClient(config);
    c.on('error', (err) => logErr(`[step-commands] client error: ${String(err)}`));

    try {
        await c.connect();
        client = c;
        log('[step-commands] DatapointClient connected to callstack_depth3 manager');
    } catch (err) {
        logErr(`[step-commands] Connection failed: ${(err as Error).message}`);
    }
});

test.after(async () => {
    if (client?.isConnected()) {
        await client.sendCommand('delete-all', 2000).catch(() => {});
        await client.sendCommand('cont', 1000).catch(() => {});
        await client.disconnect();
        log('[step-commands] DatapointClient disconnected');
    }

    if (lifecycle.isWinccoaAvailable()) {
        await lifecycle.stop();
    }

    printLocalIntegrationTestResult('debugger-step-commands', {
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

/**
 * Wait for the first unsolicited stop event (msg[0] starts with "line: ").
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

/** Parse scriptId and threadId out of a WinCC OA stop event payload. */
function extractStopContext(msg: string[]): { scriptId: number; threadId: number } {
    const scriptM = /ScriptId:\s*(\d+)/.exec(msg.find((s) => s.startsWith('ScriptId:')) ?? '');
    const threadM = /ThreadId:\s*(\d+)/.exec(msg.find((s) => s.startsWith('ThreadId:')) ?? '');
    return {
        scriptId: scriptM ? parseInt(scriptM[1], 10) : -1,
        threadId: threadM ? parseInt(threadM[1], 10) : -1,
    };
}

// ─── shared state ────────────────────────────────────────────────────────────

let stackScriptId = -1;
let capturedThreadId = -1;

// ─── connection ──────────────────────────────────────────────────────────────

test('step-commands: DatapointClient connects to callstack_depth3 manager', async (ctx) => {
    if (!lifecycle.isWinccoaAvailable()) { ctx.skip('WinCC OA not available'); return; }
    if (!client) { ctx.skip('Client not initialised'); return; }
    assert.ok(client.isConnected());
    assert.equal(client.getDebugDp(), `_CtrlDebug_CTRL_${STACK_MANAGER}`);
    log('[step-commands] ✔ connected');
});

// ─── get scriptId ─────────────────────────────────────────────────────────────

test('step-commands: info scripts returns callstack_depth3.ctl entry', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    // Ensure clean state: clear any stale BPs and let the script run freely
    await c.sendCommand('delete-all').catch(() => {});
    await c.sendCommand('cont', 500).catch(() => {});

    const result = await c.sendCommand('info scripts', 10_000);
    log(`[step-commands] info scripts: ${JSON.stringify(result)}`);

    const entry = result.find((l) => l.toLowerCase().includes('callstack_depth3'));
    assert.ok(entry, `callstack_depth3.ctl must appear in info scripts (got: ${result.join(', ')})`);

    const m = /ScriptId:\s*(\d+)/.exec(entry);
    assert.ok(m, `ScriptId must be present in entry: "${entry}"`);
    stackScriptId = parseInt(m[1], 10);
    log(`[step-commands] ✔ scriptId = ${stackScriptId}`);
});

// ─── Phase A0: stop at MULTIPLY_LINE (19) ────────────────────────────────────

test('step-commands: [A0] set BP at multiply_and_add line 19 and wait for first stop', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (stackScriptId === -1) { ctx.skip('scriptId not captured'); return; }

    const bpCmd = `breakpoint ${JSON.stringify({ scriptId: stackScriptId, scopeId: 0, lib: -1, line: MULTIPLY_LINE })}`;
    const bpResult = await c.sendCommand(bpCmd, 5_000);
    assert.equal(bpResult[0], 'breakpoint set',
        `Expected "breakpoint set", got: "${bpResult[0]}"`);
    log(`[step-commands] ✔ BP set at multiply_and_add line ${MULTIPLY_LINE}`);

    // Script is already running after the `cont` in the info-scripts test
    const stopPromise = waitForStopEvent(c, BP_STOP_TIMEOUT_MS);
    // cont is a no-op here if already running; ignore timeout
    await c.sendCommand('cont', 500).catch(() => {});
    const msg = await stopPromise;

    assert.ok(msg !== null, `No stop event within ${BP_STOP_TIMEOUT_MS}ms`);
    const line = parseInt(msg![0].slice(6), 10);
    assert.equal(line, MULTIPLY_LINE, `Must stop at line ${MULTIPLY_LINE}, got ${line}`);

    const { threadId } = extractStopContext(msg!);
    assert.ok(threadId !== -1, 'ThreadId must be present in stop event');
    capturedThreadId = threadId;
    log(`[step-commands] ✔ stopped at line ${line}, thread=${capturedThreadId}`);
});

// ─── Phase A1: bt 3-frame ────────────────────────────────────────────────────

test('step-commands: [A1] bt returns ≥ 3 frames (multiply_and_add, compute_inner, compute_outer)', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (stackScriptId === -1 || capturedThreadId === -1) {
        ctx.skip('stop context not ready');
        return;
    }

    // Set script+thread context before bt (mirrors WinCCDebugSession.attachToStopContext)
    await c.sendCommand(`script ${stackScriptId}`, 2_000);
    await c.sendCommand(`thread ${capturedThreadId}`, 2_000);

    const result = await c.sendCommand('bt', 5_000);
    log(`[step-commands] bt: ${JSON.stringify(result)}`);

    assert.ok(result.length >= 3,
        `Expected ≥ 3 call frames, got ${result.length}: ${result.join(' | ')}`);

    const all = result.join(' ').toLowerCase();
    assert.ok(all.includes('multiply_and_add'), 'bt must reference "multiply_and_add"');
    assert.ok(all.includes('compute_inner'),    'bt must reference "compute_inner"');
    assert.ok(
        all.includes('compute_outer') || all.includes('main'),
        'bt must reference "compute_outer" or "main"',
    );
    log(`[step-commands] ✔ bt returned ${result.length} frames with all expected function names`);
});

// ─── Phase A2: print x ───────────────────────────────────────────────────────

test('step-commands: [A2] print x at multiply_and_add returns a positive integer', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (stackScriptId === -1 || capturedThreadId === -1) {
        ctx.skip('stop context not ready');
        return;
    }

    await c.sendCommand(`script ${stackScriptId}`, 2_000);
    await c.sendCommand(`thread ${capturedThreadId}`, 2_000);

    const result = await c.sendCommand('print x', 5_000);
    log(`[step-commands] print x: ${JSON.stringify(result)}`);

    assert.ok(result.length > 0, '"print x" must return at least one response line');
    const text = result.join(' ');
    // WinCC OA may return the raw number or a JSON-like object; either must contain digits
    assert.match(text, /\d+/, `"print x" must contain a numeric value, got: ${text}`);
    log(`[step-commands] ✔ print x → ${text}`);
});

// ─── Phase A3: next (step-over) ──────────────────────────────────────────────

test(`step-commands: [A3] next (step-over) from line ${MULTIPLY_LINE} → stops at line ${MULTIPLY_NEXT_LINE}`, async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (stackScriptId === -1 || capturedThreadId === -1) {
        ctx.skip('stop context not ready');
        return;
    }

    // Set context (same as WinCCDebugSession.nextRequest → attachToStopContext)
    await c.sendCommand(`script ${stackScriptId}`, 2_000);
    await c.sendCommand(`thread ${capturedThreadId}`, 2_000);

    const stopPromise = waitForStopEvent(c, STEP_STOP_TIMEOUT_MS);
    // next is in EXEC_CMD_RE — WinCC OA responds with stop data, DatapointClient
    // re-emits it as 'message'.  Use short timeout so sendCommand doesn't block.
    await c.sendCommand('next', 500).catch(() => {});
    const msg = await stopPromise;

    assert.ok(msg !== null,
        `"next" must produce a stop event within ${STEP_STOP_TIMEOUT_MS}ms`);
    const line = parseInt(msg![0].slice(6), 10);
    assert.equal(line, MULTIPLY_NEXT_LINE,
        `next from line ${MULTIPLY_LINE} must stop at line ${MULTIPLY_NEXT_LINE}, got ${line}`);

    const { threadId } = extractStopContext(msg!);
    if (threadId !== -1) capturedThreadId = threadId;
    log(`[step-commands] ✔ next → line ${line}`);
});

// ─── Phase A4: finish (step-out) ─────────────────────────────────────────────

test(`step-commands: [A4] finish (step-out) from multiply_and_add → stops in compute_inner (lines ${COMPUTE_INNER_FIRST}–${COMPUTE_INNER_LAST})`, async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (stackScriptId === -1 || capturedThreadId === -1) {
        ctx.skip('stop context not ready');
        return;
    }

    // Currently paused at MULTIPLY_NEXT_LINE (20 = return result) inside multiply_and_add
    await c.sendCommand(`script ${stackScriptId}`, 2_000);
    await c.sendCommand(`thread ${capturedThreadId}`, 2_000);

    const stopPromise = waitForStopEvent(c, STEP_STOP_TIMEOUT_MS);
    await c.sendCommand('finish', 500).catch(() => {});
    const msg = await stopPromise;

    assert.ok(msg !== null,
        `"finish" must produce a stop event within ${STEP_STOP_TIMEOUT_MS}ms`);
    const line = parseInt(msg![0].slice(6), 10);
    assert.ok(
        line >= COMPUTE_INNER_FIRST && line <= COMPUTE_INNER_LAST,
        `finish from multiply_and_add must return to compute_inner ` +
        `(lines ${COMPUTE_INNER_FIRST}–${COMPUTE_INNER_LAST}), got line ${line}`,
    );

    const { threadId } = extractStopContext(msg!);
    if (threadId !== -1) capturedThreadId = threadId;
    log(`[step-commands] ✔ finish → line ${line} (inside compute_inner)`);
    // Script is now paused in compute_inner.  Phase B will resume with a new BP.
});

// ─── Phase B0: stop at COMPUTE_OUTER_CALL_LINE (31) ──────────────────────────

test('step-commands: [B0] set BP at compute_outer line 31 and wait for stop', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (stackScriptId === -1) { ctx.skip('scriptId not captured'); return; }

    // Clean up Phase A: remove all BPs, then set new BP BEFORE resuming
    await c.sendCommand('delete-all').catch(() => {});

    const bpCmd = `breakpoint ${JSON.stringify({ scriptId: stackScriptId, scopeId: 0, lib: -1, line: COMPUTE_OUTER_CALL_LINE })}`;
    const bpResult = await c.sendCommand(bpCmd, 5_000);
    assert.equal(bpResult[0], 'breakpoint set',
        `Expected "breakpoint set" at line ${COMPUTE_OUTER_CALL_LINE}, got: "${bpResult[0]}"`);
    log(`[step-commands] ✔ BP set at compute_outer line ${COMPUTE_OUTER_CALL_LINE}`);

    // Resume from wherever Phase A left the script paused (in compute_inner)
    const stopPromise = waitForStopEvent(c, BP_STOP_TIMEOUT_MS);
    await c.sendCommand('cont', 500).catch(() => {});
    const msg = await stopPromise;

    assert.ok(msg !== null,
        `No stop at compute_outer line ${COMPUTE_OUTER_CALL_LINE} within ${BP_STOP_TIMEOUT_MS}ms`);
    const line = parseInt(msg![0].slice(6), 10);
    assert.equal(line, COMPUTE_OUTER_CALL_LINE,
        `Must stop at compute_outer call line ${COMPUTE_OUTER_CALL_LINE}, got ${line}`);

    const { threadId } = extractStopContext(msg!);
    if (threadId !== -1) capturedThreadId = threadId;
    log(`[step-commands] ✔ stopped at line ${line} (compute_outer), thread=${capturedThreadId}`);
});

// ─── Phase B1: step (step-into) ──────────────────────────────────────────────

test('step-commands: [B1] step (step-into) from compute_outer → enters compute_inner', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (stackScriptId === -1 || capturedThreadId === -1) {
        ctx.skip('stop context not ready');
        return;
    }

    // Set context for the step command (mirrors WinCCDebugSession.stepInRequest)
    await c.sendCommand(`script ${stackScriptId}`, 2_000);
    await c.sendCommand(`thread ${capturedThreadId}`, 2_000);

    const stopPromise = waitForStopEvent(c, STEP_STOP_TIMEOUT_MS);
    await c.sendCommand('step', 500).catch(() => {});
    const msg = await stopPromise;

    assert.ok(msg !== null,
        `"step" must produce a stop event within ${STEP_STOP_TIMEOUT_MS}ms`);
    const line = parseInt(msg![0].slice(6), 10);

    // step INTO compute_inner: must have left the call site and landed inside compute_inner
    assert.notEqual(line, COMPUTE_OUTER_CALL_LINE,
        '"step" must move away from the call site at compute_outer');
    assert.ok(line >= 23 && line <= 27,
        `step from compute_outer (line ${COMPUTE_OUTER_CALL_LINE}) must enter compute_inner ` +
        `(lines 23–27), got line ${line}`);

    const { threadId } = extractStopContext(msg!);
    if (threadId !== -1) capturedThreadId = threadId;
    log(`[step-commands] ✔ step → line ${line} (inside compute_inner range 23–27)`);

    // Cleanup Phase B
    await c.sendCommand('delete-all', 2000).catch(() => {});
    await c.sendCommand('cont', 500).catch(() => {});
    log('[step-commands] ✔ Phase B cleanup done');
});

// ─── Phase C0: b (pause/break) ───────────────────────────────────────────────

test('step-commands: [C0] b (pause) breaks a running script at the current position', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;
    if (stackScriptId === -1) { ctx.skip('scriptId not captured'); return; }

    // Guarantee the script is running: remove any BPs and resume
    await c.sendCommand('delete-all', 2000).catch(() => {});
    await c.sendCommand('cont', 500).catch(() => {}); // resume if paused (no-op if running)

    // Brief pause to confirm the script is actively looping
    await new Promise((r) => setTimeout(r, 500));

    // "b" is in EXEC_CMD_RE: DatapointClient re-emits the WinCC OA response as 'message'
    log('[step-commands] Sending "b" to pause the running script…');
    const stopPromise = waitForStopEvent(c, 5_000);
    await c.sendCommand('b', 500).catch(() => {});
    const msg = await stopPromise;

    assert.ok(msg !== null, '"b" must produce a stop event within 5000ms');
    const line = parseInt(msg![0].slice(6), 10);
    assert.ok(line > 0, `"b" must report a valid line number, got ${line}`);
    log(`[step-commands] ✔ b paused script at line ${line}`);

    // Cleanup Phase C
    await c.sendCommand('delete-all', 2000).catch(() => {});
    await c.sendCommand('cont', 500).catch(() => {});
    log('[step-commands] ✔ Phase C cleanup done');
});
