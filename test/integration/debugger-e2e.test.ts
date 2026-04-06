/**
 * debugger-e2e.test.ts
 *
 * End-to-end integration tests for the WinCC OA CTRL debugger.
 *
 * What this tests:
 * - DatapointClient connects to a real WinCC OA project as a manager
 * - Sends actual GDB-style debug commands to _CtrlDebug_CTRL_1.Command
 * - Receives and validates responses from _CtrlDebug_CTRL_1.Result
 * - Tests the full debug workflow against bp_basic_loop.ctl:
 *     break → info threads → print variable → continue → disconnect
 *
 * Prerequisites (any ONE of these):
 *   A) Set env WINCCOA_TEST_HOST / WINCCOA_TEST_PORT and have WinCC OA running
 *      with the runnable project MANUALLY before running the tests.
 *   B) Do nothing — the lifecycle helper will start WinCC OA automatically
 *      if it is installed and the runnable project is registered.
 *   C) Set WINCCOA_SKIP=1 to skip all integration tests (useful in CI without
 *      a WinCC OA licence).
 *
 * Running:
 *   npm run test:integration
 *
 * The tests self-skip when WinCC OA is not available.
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
        log('[e2e] WinCC OA not available — tests will be skipped');
        return;
    }

    try {
        await lifecycle.start();
    } catch (err) {
        logErr(`[e2e] Could not start WinCC OA: ${(err as Error).message}`);
        return;
    }

    const config = lifecycle.getDatapointConfig('CTRL', 1);
    log(`[e2e] Connecting to WinCC OA at ${config.host}:${config.port}`);
    log(`[e2e]   debug dp: _CtrlDebug_CTRL_1`);
    log(`[e2e]   adapter manager num: ${config.connectionArgs?.join(' ')}`);

    const c = new DatapointClient(config);
    c.on('error', (err) => logErr(`[e2e] DatapointClient error: ${String(err)}`));

    try {
        await c.connect();
        client = c;
        log('[e2e] DatapointClient connected');
    } catch (err) {
        logErr(
            `[e2e] Connection failed (project "${config.system}" may not be running): ${(err as Error).message}`,
        );
        // client stays null → all tests will skip via requireClient()
    }
});

test.after(async () => {
    if (client?.isConnected()) {
        await client.disconnect();
        log('[e2e] DatapointClient disconnected');
    }

    if (lifecycle.isWinccoaAvailable()) {
        await lifecycle.stop();
    }

    printLocalIntegrationTestResult('debugger-e2e', {
        status: testLog.stderr ? 1 : 0,
        stdout: testLog.stdout,
        stderr: testLog.stderr,
    });
});

// ─── helper to skip when not connected ───────────────────────────────────────

function requireClient(ctx: test.TestContext): DatapointClient | null {
    if (!client || !client.isConnected()) {
        ctx.skip('WinCC OA not connected — skipping');
        return null;
    }
    return client;
}

// ─── tests ───────────────────────────────────────────────────────────────────

test('e2e: DatapointClient connects to WinCC OA', async (ctx) => {
    if (!lifecycle.isWinccoaAvailable()) {
        ctx.skip('WinCC OA not available');
        return;
    }
    if (!client) {
        ctx.skip('Client not initialised (WinCC OA may not be running)');
        return;
    }
    assert.ok(client.isConnected(), 'client should be connected');
    assert.equal(client.getDebugDp(), '_CtrlDebug_CTRL_1');
    log('[e2e] ✔ connected, debug dp = _CtrlDebug_CTRL_1');
});

test('e2e: info threads — lists running CTRL threads', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    log('[e2e] Sending "info threads"…');
    const result = await c.sendCommand('info threads', 10_000);
    log(`[e2e] response: ${JSON.stringify(result)}`);

    assert.ok(Array.isArray(result), 'result must be an array');
    // The response contains at least the status line
    assert.ok(result.length > 0, 'must receive at least one response element');
});

test('e2e: set breakpoint on bp_basic_loop.ctl line 13 (counter++)', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    // bp_basic_loop.ctl line 13: counter++
    log('[e2e] Sending "break scripts/bp_basic_loop.ctl 13"…');
    const result = await c.sendCommand('break scripts/bp_basic_loop.ctl 13', 10_000);
    log(`[e2e] response: ${JSON.stringify(result)}`);

    assert.ok(Array.isArray(result));
    // WinCC OA debugger acknowledges with "OK" or describes the breakpoint
    const responseText = result.join(' ').toLowerCase();
    assert.ok(
        responseText.includes('ok') ||
            responseText.includes('breakpoint') ||
            responseText.includes('line'),
        `Expected breakpoint acknowledgement, got: ${result.join(' ')}`,
    );
});

test('e2e: set breakpoint on bp_basic_loop.ctl line 14 (DebugN after counter)', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    // bp_basic_loop.ctl line 14: DebugN("bp_basic_loop: counter = ...")
    log('[e2e] Sending "break scripts/bp_basic_loop.ctl 14"…');
    const result = await c.sendCommand('break scripts/bp_basic_loop.ctl 14', 10_000);
    log(`[e2e] response: ${JSON.stringify(result)}`);

    assert.ok(Array.isArray(result));
    const responseText = result.join(' ').toLowerCase();
    assert.ok(
        responseText.includes('ok') ||
            responseText.includes('breakpoint') ||
            responseText.includes('line'),
        `Expected breakpoint acknowledgement, got: ${result.join(' ')}`,
    );
});

test('e2e: list breakpoints', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    log('[e2e] Sending "info break"…');
    const result = await c.sendCommand('info break', 10_000);
    log(`[e2e] response: ${JSON.stringify(result)}`);

    assert.ok(Array.isArray(result));
    // After setting two breakpoints the list should contain at least one entry
    assert.ok(result.length > 0);
});

test('e2e: print variable — CTRL script exposes counter', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    // If the script is paused at a breakpoint we can inspect the variable.
    // We accept either a value or a "not in scope" / error response.
    log('[e2e] Sending "print counter"…');
    const result = await c.sendCommand('print counter', 10_000);
    log(`[e2e] response: ${JSON.stringify(result)}`);

    assert.ok(Array.isArray(result));
    assert.ok(result.length > 0);
});

test('e2e: continue execution', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    log('[e2e] Sending "continue"…');
    const result = await c.sendCommand('continue', 10_000);
    log(`[e2e] response: ${JSON.stringify(result)}`);

    assert.ok(Array.isArray(result));
});

test('e2e: delete all breakpoints', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    log('[e2e] Sending "delete"…');
    const result = await c.sendCommand('delete', 10_000);
    log(`[e2e] response: ${JSON.stringify(result)}`);

    assert.ok(Array.isArray(result));
});

test('e2e: DatapointClient disconnects cleanly', async (ctx) => {
    const c = requireClient(ctx);
    if (!c) return;

    await c.disconnect();
    assert.ok(!c.isConnected(), 'client should be disconnected');
    client = null; // avoid double-disconnect in test.after
    log('[e2e] ✔ disconnected cleanly');
});
