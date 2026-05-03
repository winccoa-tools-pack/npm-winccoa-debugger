/**
 * debugger-adapter-race-condition.test.ts
 *
 * Regression test for the "double stop" race condition in WinCCDebugSession:
 *
 *   Root cause:
 *     VS Code sends one setBreakpoints request per source file, all at once
 *     (concurrently).  Without serialization, two concurrent async work()
 *     functions in setBreakPointsRequest both call `delete-all + reapply`.
 *     The overlapping executions leave WinCC OA with the same line set TWICE
 *     as independent breakpoints, causing the script to stop twice per loop
 *     iteration at that line.
 *
 *   Fix:
 *     `bpOperationQueue` in WinCCDebugSession serializes all setBreakpoints
 *     work() calls via Promise chaining (.then()) so they run sequentially.
 *
 *   Test strategy:
 *     1. Create IntegrationDebugSession (WinCCDebugSession with real DatapointClient).
 *     2. Attach to manager 1 (bp_basic_loop.ctl — endless loop with delay(1)).
 *     3. Concurrently call setBreakPointsRequest for TWO files (simulating VS Code):
 *        - bp_basic_loop.ctl:13  (runs on manager 1)
 *        - call_library_function.ctl:14  (runs on manager 3 — unknown to this client)
 *     4. Wait for first StoppedEvent at line 13.
 *     5. Send continueRequest.
 *     6. Measure time until next StoppedEvent.
 *     7. Assert:  Δt > 500 ms
 *        - WITHOUT fix: WinCC OA has BP at line 13 TWICE.  After continue,
 *          the second duplicate BP fires IMMEDIATELY (< 100 ms) at the same line.
 *        - WITH fix:    One BP at line 13.  Next stop is after a full loop
 *          iteration (~1 000 ms because of `delay(1)` in bp_basic_loop.ctl).
 *
 * Requirements:
 *   WINCCOA_TEST_PROJ=runnable (or WINCCOA_EXTERNAL=1 with project running)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { DebugProtocol } from '@vscode/debugprotocol';
import {
    WinCCDebugSession,
    AttachRequestArguments,
} from '../../src/adapter/WinCCDebugSession.js';
import { DatapointClient, DatapointConfig } from '../../src/connection/DatapointClient.js';
import { WinccoaProjectLifecycle } from '../helpers/WinccoaProjectLifecycle.js';
import { printLocalIntegrationTestResult } from '../helpers/integration-teardown.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── constants ───────────────────────────────────────────────────────────────

/** Manager for bp_basic_loop.ctl (always-running endless loop, delay(1) per iter) */
const BP_MANAGER = 1;
/** Line in bp_basic_loop.ctl: `counter++;` */
const BP_LINE = 13;
/** Timeout to receive the first StoppedEvent after attach */
const FIRST_STOP_TIMEOUT_MS = 12_000;
/** Time allowed for the next stop event after continue */
const NEXT_STOP_TIMEOUT_MS = 5_000;
/**
 * Minimum elapsed time between continue and the NEXT StoppedEvent.
 * bp_basic_loop.ctl has `delay(1)` — a full iteration takes ~1 000 ms.
 * A duplicate BP fires IMMEDIATELY (< 100 ms).  500 ms is a safe threshold.
 */
const MIN_LEGITIMATE_ITER_MS = 500;

// ─── instrumented session ────────────────────────────────────────────────────

/**
 * WinCCDebugSession wrapper for integration testing.
 *
 * Overrides:
 *  - createDatapointClient  → real client with injected connectionArgs
 *  - sendResponse / sendEvent → captured for assertions + promise-resolution
 */
class IntegrationDebugSession extends WinCCDebugSession {
    public connectionArgs: string[] = [];
    public readonly sentResponses: DebugProtocol.Response[] = [];
    public readonly sentEvents: DebugProtocol.Event[] = [];

    private readonly _eventWaiters = new Map<
        string,
        Array<(e: DebugProtocol.Event) => void>
    >();

    protected override createDatapointClient(config: DatapointConfig): DatapointClient {
        return new DatapointClient({ ...config, connectionArgs: this.connectionArgs });
    }

    override sendResponse(response: DebugProtocol.Response): void {
        this.sentResponses.push(JSON.parse(JSON.stringify(response)));
    }

    override sendEvent(event: DebugProtocol.Event): void {
        const copy: DebugProtocol.Event = JSON.parse(JSON.stringify(event));
        this.sentEvents.push(copy);

        const waiters = this._eventWaiters.get(event.event);
        if (waiters && waiters.length > 0) {
            const waiter = waiters.shift()!;
            if (waiters.length === 0) this._eventWaiters.delete(event.event);
            waiter(copy);
        }
    }

    waitForEvent(type: string, timeoutMs: number): Promise<DebugProtocol.Event | null> {
        return new Promise((resolve) => {
            const waiters = this._eventWaiters.get(type) ?? [];
            waiters.push(resolve as (e: DebugProtocol.Event) => void);
            this._eventWaiters.set(type, waiters);

            setTimeout(() => {
                const w = this._eventWaiters.get(type);
                if (w) {
                    const idx = w.indexOf(resolve as (e: DebugProtocol.Event) => void);
                    if (idx >= 0) {
                        w.splice(idx, 1);
                        if (w.length === 0) this._eventWaiters.delete(type);
                    }
                }
                resolve(null);
            }, timeoutMs);
        });
    }
}

function makeResponse<T extends DebugProtocol.Response>(command: string): T {
    return { seq: 1, type: 'response', request_seq: 1, success: true, command, body: {} } as unknown as T;
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

const PROJ_PATH = path.resolve(__dirname, '../fixtures/projects/runnable');
const lifecycle = new WinccoaProjectLifecycle(PROJ_PATH);
let session: IntegrationDebugSession | null = null;
const testLog = { stdout: '', stderr: '' };

function log(msg: string) { testLog.stdout += msg + '\n'; console.log(`[race] ${msg}`); }
function logErr(msg: string) { testLog.stderr += msg + '\n'; console.error(`[race] ${msg}`); }

const SCRIPTS_DIR = path.resolve(PROJ_PATH, 'scripts');
const BP_LOOP_PATH = path.join(SCRIPTS_DIR, 'bp_basic_loop.ctl');
const CALL_LIB_PATH = path.join(SCRIPTS_DIR, 'call_library_function.ctl');

// ─── setup/teardown ──────────────────────────────────────────────────────────

test.before(async () => {
    if (!lifecycle.isWinccoaAvailable()) {
        log('WinCC OA not available — tests will be skipped');
        return;
    }

    try {
        await lifecycle.start();
        // Give the always-mode managers a moment to start before connecting
        await new Promise((r) => setTimeout(r, 1_500));
    } catch (err) {
        logErr(`Could not start WinCC OA: ${(err as Error).message}`);
        return;
    }

    const dpConfig = lifecycle.getDatapointConfig('CTRL', BP_MANAGER);
    const s = new IntegrationDebugSession();
    s.connectionArgs = dpConfig.connectionArgs ?? [];
    session = s;

    log('Attaching WinCCDebugSession…');
    const initEvent = s.waitForEvent('initialized', 10_000);
    const attachArgs: AttachRequestArguments = {
        system: dpConfig.system,
        host: dpConfig.host,
        port: dpConfig.port,
        manager: { type: 'CTRL', number: BP_MANAGER },
    };
    (s as any).attachRequest(makeResponse('attach'), attachArgs);

    const ev = await initEvent;
    if (!ev) {
        logErr('Timed out waiting for InitializedEvent — WinCC OA connection failed');
        session = null;
        return;
    }
    log('InitializedEvent received — adapter connected');
});

test.after(async () => {
    if (session) {
        await (session as any).cleanupClient().catch(() => {});
    }

    if (lifecycle.isWinccoaAvailable()) {
        await lifecycle.stop();
    }

    printLocalIntegrationTestResult('adapter-race-condition', {
        status: testLog.stderr ? 1 : 0,
        stdout: testLog.stdout,
        stderr: testLog.stderr,
    });
});

function requireSession(ctx: test.TestContext): IntegrationDebugSession | null {
    if (!session) { ctx.skip('Session not initialised'); return null; }
    const client = (session as any).client as DatapointClient | null;
    if (!client?.isConnected()) { ctx.skip('Adapter not connected'); return null; }
    return session;
}

// ─── tests ───────────────────────────────────────────────────────────────────

test('race-condition: adapter session connects to manager 1', async (ctx) => {
    if (!lifecycle.isWinccoaAvailable()) { ctx.skip('WinCC OA not available'); return; }
    if (!session) { ctx.skip('Session not initialised'); return; }
    const client = (session as any).client as DatapointClient;
    assert.ok(client.isConnected(), 'DatapointClient must be connected');
    log('✔ adapter connected');
});

let capturedFirstStopLine = -1;

test('race-condition: concurrent setBreakpoints for two files — no duplicate BPs', async (ctx) => {
    const s = requireSession(ctx);
    if (!s) return;

    // ── Simulate VS Code: send setBreakpoints for TWO files simultaneously ────
    // Call A: bp_basic_loop.ctl:13  (known to manager 1 → will be set)
    // Call B: call_library_function.ctl:14  (unknown to manager 1 → pending, but
    //          triggers a concurrent delete-all + reapply on the same connection)
    //
    // Without bpOperationQueue fix: both work() calls run concurrently, each
    // issues delete-all + set-all → line 13 ends up set TWICE.
    // With fix: serialized, line 13 set exactly once.

    log('Sending concurrent setBreakpoints for two source files…');

    const respA = makeResponse<DebugProtocol.SetBreakpointsResponse>('setBreakpoints');
    const respB = makeResponse<DebugProtocol.SetBreakpointsResponse>('setBreakpoints');

    // DO NOT await — fire both without waiting to trigger the race
    (s as any).setBreakPointsRequest(respA, {
        source: { path: BP_LOOP_PATH },
        breakpoints: [{ line: BP_LINE }],
    });
    (s as any).setBreakPointsRequest(respB, {
        source: { path: CALL_LIB_PATH },
        breakpoints: [{ line: 14 }],
    });

    // configurationDone — signals VS Code that initial BP configuration is complete
    // (adapter: just emits ContinuedEvent, does not affect WinCC OA state)
    (s as any).configurationDoneRequest(makeResponse('configurationDone'), {});

    // ── Wait for the first genuine stop ──────────────────────────────────────
    log(`Waiting up to ${FIRST_STOP_TIMEOUT_MS}ms for first stop at line ${BP_LINE}…`);
    const firstStop = await s.waitForEvent('stopped', FIRST_STOP_TIMEOUT_MS);
    assert.ok(firstStop !== null, `No StoppedEvent within ${FIRST_STOP_TIMEOUT_MS}ms after attach`);
    capturedFirstStopLine = (firstStop!.body as DebugProtocol.StoppedEvent['body']).threadId ?? -1;
    log(`✔ first StoppedEvent (thread=${capturedFirstStopLine})`);

    // ── Continue and measure time to the NEXT stop ────────────────────────────
    const continueTs = Date.now();
    const nextStopPromise = s.waitForEvent('stopped', NEXT_STOP_TIMEOUT_MS);
    (s as any).continueRequest(makeResponse('continue'), { threadId: 0 });

    const nextStop = await nextStopPromise;
    const deltaMs = Date.now() - continueTs;

    assert.ok(
        nextStop !== null,
        `No second StoppedEvent within ${NEXT_STOP_TIMEOUT_MS}ms — script may have stopped running`,
    );
    log(`Next stop arrived after ${deltaMs}ms`);

    // ── Key assertion ─────────────────────────────────────────────────────────
    // If duplicate BPs were set:     deltaMs ≈ 0–100 ms (second BP fires immediately)
    // If serialization worked:       deltaMs ≈ 1000 ms  (full loop iteration with delay(1))
    assert.ok(
        deltaMs >= MIN_LEGITIMATE_ITER_MS,
        `RACE CONDITION DETECTED: next stop arrived after only ${deltaMs}ms. ` +
        `Expected >= ${MIN_LEGITIMATE_ITER_MS}ms (one full loop iteration). ` +
        `Duplicate BPs at line ${BP_LINE} cause the script to stop twice per iteration — ` +
        `the second stop fires immediately after continue (no delay(1) needed).`,
    );

    log(`✔ no duplicate BPs — next stop after ${deltaMs}ms (expected ≥ ${MIN_LEGITIMATE_ITER_MS}ms)`);
});
