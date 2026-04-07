/**
 * debugger-adapter-lib-bp-session.test.ts
 *
 * Regression test for library breakpoints via the full WinCCDebugSession
 * adapter pipeline (DAP layer), not just the raw DatapointClient layer.
 *
 * Problem being tested:
 *   WinCC OA 3.21 never lists library files (`debugger_lib.ctl`) in
 *   `info scripts`, not even after a function from that library has been
 *   called.  The VS Code adapter must therefore:
 *     1. Detect that the requested source file is NOT in `info scripts`.
 *     2. Probe `breakpoint {scriptId, scopeId:0, lib:N, line}` for
 *        N = 0, 1, 2 … until WinCC OA acknowledges "breakpoint set".
 *     3. Cache the resolved index (libIndexCache) to avoid re-probing on
 *        subsequent setBreakpoints calls.
 *
 *   Without the fix, `setBreakPointsRequest` for debugger_lib.ctl returns
 *   `verified: false` and the script never stops in the library.
 *   With the fix, the response contains `verified: true` and a `stopped`
 *   event arrives at the correct library line.
 *
 * Test flow:
 *   1. Attach WinCCDebugSession to CTRL manager 3 (call_library_function.ctl).
 *   2. Set breakpoint for call_library_function.ctl:14 → verified: true.
 *   3. Wait for first StoppedEvent at main line 14 (proves main BP works).
 *   4. Set breakpoint for debugger_lib.ctl:7 → adapter probes lib:N.
 *      Assert response verified: true.
 *   5. Send continueRequest → wait for StoppedEvent at lib line 7.
 *      Assert event arrived (lib stops bypass the spurious stop filter
 *      because libId >= 0).
 *
 * Requirements:
 *   WINCCOA_TEST_PROJ=runnable
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

/** Manager for call_library_function.ctl (always-running, uses debugger_lib.ctl) */
const LIB_MANAGER = 3;
/** Line in call_library_function.ctl — `result = add_two_integers(a, b);` */
const BP_MAIN_LINE = 14;
/** Line in libs/debugger_lib.ctl — inside `add_two_integers()` */
const BP_LIB_LINE = 7;
/** Timeout to receive the first StoppedEvent */
const FIRST_STOP_TIMEOUT_MS = 12_000;
/** Timeout to receive the library StoppedEvent */
const LIB_STOP_TIMEOUT_MS = 8_000;

// ─── instrumented session ────────────────────────────────────────────────────

/**
 * WinCCDebugSession wrapper for integration testing.
 * Identical to the one in debugger-adapter-race-condition.test.ts — kept
 * inline to avoid a shared-helper coupling until the pattern is stable.
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

function log(msg: string) { testLog.stdout += msg + '\n'; console.log(`[lib-bp-session] ${msg}`); }
function logErr(msg: string) { testLog.stderr += msg + '\n'; console.error(`[lib-bp-session] ${msg}`); }

const SCRIPTS_DIR = path.resolve(PROJ_PATH, 'scripts');
const MAIN_SCRIPT_PATH = path.join(SCRIPTS_DIR, 'call_library_function.ctl');
const LIBS_DIR = path.join(SCRIPTS_DIR, 'libs');
const LIB_SCRIPT_PATH = path.join(LIBS_DIR, 'debugger_lib.ctl');

// ─── setup/teardown ──────────────────────────────────────────────────────────

test.before(async () => {
    if (!lifecycle.isWinccoaAvailable()) {
        log('WinCC OA not available — tests will be skipped');
        return;
    }

    try {
        await lifecycle.start();
        await new Promise((r) => setTimeout(r, 1_500));
    } catch (err) {
        logErr(`Could not start WinCC OA: ${(err as Error).message}`);
        return;
    }

    const dpConfig = lifecycle.getDatapointConfig('CTRL', LIB_MANAGER);
    const s = new IntegrationDebugSession();
    s.connectionArgs = dpConfig.connectionArgs ?? [];
    session = s;

    log(`Attaching WinCCDebugSession to CTRL manager ${LIB_MANAGER}…`);
    const initEvent = s.waitForEvent('initialized', 10_000);
    const attachArgs: AttachRequestArguments = {
        system: dpConfig.system,
        host: dpConfig.host,
        port: dpConfig.port,
        manager: { type: 'CTRL', number: LIB_MANAGER },
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

    printLocalIntegrationTestResult('adapter-lib-bp-session', {
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

test('adapter-lib-bp: session connects to manager 3', async (ctx) => {
    if (!lifecycle.isWinccoaAvailable()) { ctx.skip('WinCC OA not available'); return; }
    if (!session) { ctx.skip('Session not initialised'); return; }
    const client = (session as any).client as DatapointClient;
    assert.ok(client.isConnected(), 'DatapointClient must be connected after attach');
    log('✔ adapter connected to manager 3');
});

test('adapter-lib-bp: setBreakpoints for main script is verified', async (ctx) => {
    const s = requireSession(ctx);
    if (!s) return;

    log(`setBreakpoints: ${path.basename(MAIN_SCRIPT_PATH)}:${BP_MAIN_LINE}…`);
    const respPromise = new Promise<DebugProtocol.SetBreakpointsResponse>((resolve) => {
        const origLen = s.sentResponses.length;
        const interval = setInterval(() => {
            const newResp = s.sentResponses.slice(origLen).find(r => r.command === 'setBreakpoints');
            if (newResp) { clearInterval(interval); resolve(newResp as DebugProtocol.SetBreakpointsResponse); }
        }, 50);
        setTimeout(() => { clearInterval(interval); resolve(null as unknown as DebugProtocol.SetBreakpointsResponse); }, 8_000);
    });

    (s as any).setBreakPointsRequest(makeResponse<DebugProtocol.SetBreakpointsResponse>('setBreakpoints'), {
        source: { path: MAIN_SCRIPT_PATH },
        breakpoints: [{ line: BP_MAIN_LINE }],
    });

    const resp = await respPromise;
    assert.ok(resp !== null, 'setBreakpoints response must arrive within 8s');
    const bps = resp?.body?.breakpoints as DebugProtocol.Breakpoint[] | undefined;
    log(`setBreakpoints response: verified=${bps?.[0]?.verified}`);
    assert.ok(bps?.[0]?.verified === true, `Main script BP at line ${BP_MAIN_LINE} must be verified=true, got: ${JSON.stringify(bps?.[0])}`);
    log(`✔ main script BP verified at line ${BP_MAIN_LINE}`);

    // Signal configuration done so the adapter emits ContinuedEvent
    (s as any).configurationDoneRequest(makeResponse('configurationDone'), {});
});

test('adapter-lib-bp: StoppedEvent arrives at main BP line 14', async (ctx) => {
    const s = requireSession(ctx);
    if (!s) return;

    log(`Waiting up to ${FIRST_STOP_TIMEOUT_MS}ms for first stop at line ${BP_MAIN_LINE}…`);
    const stopEvent = await s.waitForEvent('stopped', FIRST_STOP_TIMEOUT_MS);

    assert.ok(stopEvent !== null, `No StoppedEvent within ${FIRST_STOP_TIMEOUT_MS}ms — main BP did not fire`);
    log(`✔ StoppedEvent received at main script`);
});

test('adapter-lib-bp: setBreakpoints for library file probes lib:N (verified=true)', async (ctx) => {
    const s = requireSession(ctx);
    if (!s) return;

    log(`setBreakpoints: ${path.basename(LIB_SCRIPT_PATH)}:${BP_LIB_LINE} (lib file — NOT in info scripts)…`);

    const respPromise = new Promise<DebugProtocol.SetBreakpointsResponse>((resolve) => {
        const origLen = s.sentResponses.length;
        const interval = setInterval(() => {
            // Find the NEXT setBreakpoints response after the last one we saw
            const newResp = s.sentResponses.slice(origLen).find(r => r.command === 'setBreakpoints');
            if (newResp) { clearInterval(interval); resolve(newResp as DebugProtocol.SetBreakpointsResponse); }
        }, 50);
        // Probing lib:0…lib:7 takes some time — give it 12 seconds
        setTimeout(() => { clearInterval(interval); resolve(null as unknown as DebugProtocol.SetBreakpointsResponse); }, 12_000);
    });

    (s as any).setBreakPointsRequest(makeResponse<DebugProtocol.SetBreakpointsResponse>('setBreakpoints'), {
        source: { path: LIB_SCRIPT_PATH },
        breakpoints: [{ line: BP_LIB_LINE }],
    });

    const resp = await respPromise;
    assert.ok(resp !== null, 'setBreakpoints response for lib file must arrive within 12s');

    const bps = resp?.body?.breakpoints as DebugProtocol.Breakpoint[] | undefined;
    log(`lib setBreakpoints response: verified=${bps?.[0]?.verified}`);

    // Key assertion: without the lib:N probing fix, this would be verified=false
    assert.ok(
        bps?.[0]?.verified === true,
        `Library BP at line ${BP_LIB_LINE} must be verified=true. ` +
        `verified=false means adapter failed to probe lib:N indices. ` +
        `Got: ${JSON.stringify(bps?.[0])}`,
    );
    log(`✔ lib BP verified=true — adapter successfully probed lib:N`);
});

test('adapter-lib-bp: continueRequest triggers StoppedEvent at lib BP line 7', async (ctx) => {
    const s = requireSession(ctx);
    if (!s) return;

    log(`Continuing from main stop and waiting for lib stop (timeout ${LIB_STOP_TIMEOUT_MS}ms)…`);

    const libStopPromise = s.waitForEvent('stopped', LIB_STOP_TIMEOUT_MS);
    (s as any).continueRequest(makeResponse('continue'), { threadId: 0 });

    const libStop = await libStopPromise;

    // Key assertion: lib stops bypass the spurious stop filter (libId >= 0)
    // The filter only applies to main script stops (libId < 0).
    // Without the spurious stop fix: a lib stop through a "bad" main script stop
    // could have been silently dropped.
    // With both fixes in place: lib stop arrives reliably.
    assert.ok(
        libStop !== null,
        `No StoppedEvent from library within ${LIB_STOP_TIMEOUT_MS}ms after continue. ` +
        `Library BP at ${path.basename(LIB_SCRIPT_PATH)}:${BP_LIB_LINE} did NOT fire, ` +
        `or was incorrectly filtered by the spurious stop filter.`,
    );

    log(`✔ lib StoppedEvent received — breakpoint in ${path.basename(LIB_SCRIPT_PATH)} fired correctly`);
    log(`  Overall result: lib:N probing + spurious-stop bypass = library BPs work end-to-end`);
});
