/**
 * WinCCDebugSession
 *
 * Main Debug Adapter Protocol (DAP) session handler for WinCC OA debugging.
 * Extends vscode-debugadapter's DebugSession to bridge DAP requests to the
 * WinCC OA CTRL debugger via DatapointClient.
 *
 * Protocol flow:
 * 1. VS Code sends initializeRequest → adapter responds with capabilities
 * 2. VS Code sends attachRequest → adapter connects via DatapointClient,
 *    responds, then sends InitializedEvent
 * 3. VS Code sends setBreakpoints, configurationDone (adapter is now connected)
 * 4. Unsolicited stop events from WinCC OA → StoppedEvent to VS Code
 *
 * WinCC OA debugger DP protocol:
 * - Command DP: _CtrlDebug_CTRL_1._CtrlDebug.Command  (write JSON {"id":"uuid","cmd":"..."})
 * - Result DP:  _CtrlDebug_CTRL_1._CtrlDebug.Result   (dpConnect subscription, returns JSON array)
 * - Solicited response: ["uuid", "OK", ...]  or ["uuid", "ERROR", "message"]
 * - Unsolicited stop:   ["", "stopped", reason, threadId, file?, line?]
 *
 * @see https://microsoft.github.io/debug-adapter-protocol/
 */

import path from 'path';
import {
    DebugSession,
    BreakpointEvent,
    ContinuedEvent,
    InitializedEvent,
    TerminatedEvent,
    StoppedEvent,
    Thread,
    StackFrame,
    Source,
    Scope,
    Breakpoint,
    Variable,
    OutputEvent,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DatapointClient, DatapointConfig } from '../connection/DatapointClient';

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /**
     * WinCC OA project name — passed as `-proj <project>` when the adapter connects.
     * Typically the project directory base name, e.g. `DevEnv3.21`.
     * When omitted, `system` is used as a fallback (for backward compatibility).
     */
    project?: string;
    /** WinCC OA system name (used as DP prefix, e.g. `System1:`) */
    system: string;
    /** Host where WinCC OA is running */
    host: string;
    /** Port for datapoint connection */
    port: number;
    /** Manager configuration */
    manager: {
        type: 'CTRL' | 'UI' | 'EVENT' | 'ASCII' | 'DEVICE' | 'API' | 'DRIVER';
        number: number;
    };
    /**
     * Manager number the debug adapter itself uses when connecting to WinCC OA.
     * Must be a number not already taken by another manager in the project.
     * Defaults to 99.
     */
    adapterManagerNumber?: number;
    /** Path mappings: local VS Code path → WinCC OA path */
    pathMappings?: Record<string, string>;
    /** Enable verbose logging to the debug console */
    trace?: boolean;
}

export interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
    /**
     * WinCC OA project name — passed as `-proj <project>` when the adapter connects.
     * Typically the project directory base name, e.g. `DevEnv3.21`.
     * When omitted, `system` is used as a fallback (for backward compatibility).
     */
    project?: string;
    /** WinCC OA system name (used as DP prefix, e.g. `System1:`) */
    system: string;
    /** Host where WinCC OA is running */
    host: string;
    /** Port for datapoint connection */
    port: number;
    /** Manager configuration */
    manager: {
        type: 'CTRL' | 'UI' | 'EVENT' | 'ASCII' | 'DEVICE' | 'API' | 'DRIVER';
        number: number;
    };
    /**
     * Manager number the debug adapter itself uses when connecting to WinCC OA.
     * Must be a number not already taken by another manager in the project.
     * Defaults to 99.
     */
    adapterManagerNumber?: number;
    /**
     * When true, the adapter expects the script to be paused at `DebugBreak()`
     * on attach. The adapter will NOT resume after connecting and instead waits
     * for the stop event delivered via `answerOnConnect`.
     *
     * Requires: manager started with `-dbg 6` (CTRL_DEBUGBREAK flag).
     */
    stopOnEntry?: boolean;
    /** Path mappings: local VS Code path → WinCC OA path */
    pathMappings?: Record<string, string>;
    /** Enable verbose logging to the debug console */
    trace?: boolean;
}

/** Identifies what a variablesReference points to */
interface VarHandleInfo {
    type: 'locals' | 'expression' | 'children';
    frameId?: number;
    expression?: string;
    /** Pre-built child variables for composite types (dyn_*, mapping). */
    children?: Variable[];
}

export class WinCCDebugSession extends DebugSession {
    private client: DatapointClient | null = null;
    private trace: boolean = false;
    private pathMappings: Record<string, string> = {};

    /** Maps variablesReference → scope descriptor */
    private readonly varHandles = new Map<number, VarHandleInfo>();
    private varHandleCounter = 1000;

    /** Default thread id for the CTRL manager */
    private readonly CTRL_THREAD_ID = 0;

    /**
     * Stop context captured from the last unsolicited stop event.
     * Required to select the correct script/thread before bt/locals/print.
     */
    private stopState: {
        scriptId: number;
        threadId: number;
        scopeId: number;
        libId?: number;
    } | null = null;

    /**
     * Set to true when `stopOnEntry` is active. configurationDoneRequest
     * will send a StoppedEvent instead of ContinuedEvent in this case.
     */
    private stopOnEntryPending = false;

    /**
     * Set to the expected stop reason when a step or pause command is in flight.
     * The spurious-stop filter is bypassed while this is set, so that step/pause
     * results (which stop at non-BP lines) are forwarded to VS Code.
     * Cleared as soon as the next stop event is received.
     */
    private pendingStopReason: 'step' | 'pause' | null = null;

    /**
     * Breakpoints that could not be set during the initial setBreakpoints call
     * because the source file was not yet listed in 'info scripts'.
     *
     * This happens for library files loaded via `#uses`: they are compiled and
     * linked at startup but only appear in `info scripts` once a function from
     * them has an active call frame.  We retry setting them on every stop event
     * and notify VS Code via BreakpointEvent when verification succeeds.
     *
     * Key:   absolute source path
     * Value: array of {bp, line} where bp is the Breakpoint object already sent
     *        to VS Code (so we can update bp.verified and notify via event).
     */
    private pendingBpRequests = new Map<string, Array<{ bp: Breakpoint; line: number }>>();

    /**
     * Cache of library file basename → WinCC OA lib index used in breakpoint command.
     *
     * WinCC OA library scripts loaded via `#uses` are compiled into the CTRL
     * manager and do NOT appear in `info scripts`.  To set a breakpoint in them
     * we probe `breakpoint {scriptId:S, scopeId:0, lib:N, line:L}` for every
     * scriptId S from `info scripts` and N = 0, 1, … until one succeeds.
     * Both the scriptId and lib index are cached for subsequent requests.
     *
     * The lib index corresponds to the 0-based position of the `#uses` directive
     * in the main script (first `#uses` → lib 0, second → lib 1, etc.).
     */
    private libIndexCache = new Map<string, { scriptId: number; libIndex: number }>();

    /** All active breakpoints by source path → line numbers. Used to reapply after delete-all. */
    private bpRegistry = new Map<string, number[]>();

    /** Reverse map: WinCC OA scriptId → absolute source path. Built as BPs are set. */
    private scriptIdToPath = new Map<number, string>();

    /**
     * Serializes all setBreakpoints operations. VS Code sends concurrent
     * setBreakpointsRequest calls (one per source file) — without serialization
     * the concurrent delete-all + reapply sequences overlap and produce duplicate
     * BPs in WinCC OA (causing the same line to fire twice per iteration).
     */
    private bpOperationQueue: Promise<void> = Promise.resolve();

    /**
     * Interval timer that retries pending breakpoints every 500 ms after
     * configurationDone. Breaks the chicken-and-egg where the CTRL script
     * started too recently for 'info scripts' to list it during setBreakpoints.
     * Auto-cancels once pendingBpRequests is empty.
     */
    private pendingBpRetryTimer: ReturnType<typeof setInterval> | undefined;

    /** Prevents concurrent retryPendingBreakpoints executions from the timer and stop-event paths. */
    private pendingBpRetryInFlight = false;

    /** Maximum lib index to probe when searching for a library file. */
    private static readonly MAX_LIB_PROBE = 8;

    constructor() {
        super();
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    /**
     * Always log to stderr — visible in VS Code's "Debug Output" panel.
     * Also send as OutputEvent to the Debug Console if trace is enabled.
     */
    private log(msg: string): void {
        process.stderr.write(`[winccoa-debug] ${msg}\n`);
        if (this.trace) {
            this.sendEvent(new OutputEvent(`[winccoa-debug] ${msg}\n`, 'console'));
        }
    }

    private allocVarHandle(info: VarHandleInfo): number {
        const ref = this.varHandleCounter++;
        this.varHandles.set(ref, info);
        return ref;
    }

    /** Map a VS Code local path to the WinCC OA remote path */
    private toWinCCOAPath(vscodePath: string): string {
        for (const [local, remote] of Object.entries(this.pathMappings)) {
            if (vscodePath.startsWith(local)) {
                // Strip the local prefix, then prepend the remote base.
                // Resulting relative path must NOT have a leading slash.
                const rel = vscodePath.slice(local.length).replace(/\\/g, '/').replace(/^\//, '');
                const cleanRemote = remote.replace(/\/$/, '');
                return cleanRemote ? `${cleanRemote}/${rel}` : rel;
            }
        }
        return vscodePath;
    }

    /** Map a WinCC OA remote path back to the VS Code local path */
    private toVSCodePath(wccoaPath: string): string {
        const isAbsolute = wccoaPath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(wccoaPath);
        for (const [local, remote] of Object.entries(this.pathMappings)) {
            if (remote === '') {
                // Empty remote means OA scripts are addressed with bare filenames.
                // If WinCC OA already returns an absolute path, no prepending needed —
                // just return it as-is (same machine, paths are already correct).
                if (isAbsolute) {
                    return wccoaPath;
                }
                return local.replace(/\/$/, '') + '/' + wccoaPath.replace(/^\//, '');
            }
            if (wccoaPath.startsWith(remote + '/') || wccoaPath === remote) {
                const rel = wccoaPath.slice(remote.length).replace(/^\//, '');
                return local.replace(/\/$/, '') + '/' + rel;
            }
        }
        return wccoaPath;
    }

    /**
     * Handle unsolicited messages from WinCC OA (stop events, output, etc.).
     *
     * WinCC OA CTRL engine breakpoint/step stop format (real protocol):
     *   msg[0] = "line: N"               — line number where execution stopped
     *   msg[1] = "lib: LibId: -1 ..."    — lib info (may be empty / vary)
     *   msg[2] = "ScriptId: N"           — numeric script ID
     *   msg[3] = "ScopeId: N"            — scope ID (0 for main script)
     *   msg[4] = "ThreadId: N (stopped)" — thread ID and state
     *
     * Legacy/test format kept for backward compatibility:
     *   msg[0] = "stopped", msg[1] = reason, msg[2] = threadId
     */
    private handleUnsolicitedMessage(msg: string[]): void {
        if (msg.length === 0) {
            return;
        }

        // WinCC OA CTRL engine stop notification: starts with "line: N"
        if (msg[0]?.startsWith('line: ')) {
            // ThreadId field: "ThreadId: N (stopped)" or "ThreadId: N (running)"
            const threadEntry = msg.find((m) => m.startsWith('ThreadId:')) ?? '';
            const threadMatch = /ThreadId:\s*(\d+)/.exec(threadEntry);
            const threadId = threadMatch ? parseInt(threadMatch[1], 10) : this.CTRL_THREAD_ID;
            const isStopped = threadEntry.includes('(stopped)');
            if (isStopped) {
                const lineNum = parseInt(msg[0].slice(6), 10) || 0;
                // Capture script/scope IDs so subsequent bt/locals/print can call
                // 'script N' + 'thread N' first (required by WinCC OA 3.21 protocol).
                const scriptEntry = msg.find((m) => m.startsWith('ScriptId:')) ?? '';
                const scriptMatch = /ScriptId:\s*(\d+)/.exec(scriptEntry);
                const scriptId = scriptMatch ? parseInt(scriptMatch[1], 10) : 0;
                const scopeEntry = msg.find((m) => m.startsWith('ScopeId:')) ?? '';
                const scopeMatch = /ScopeId:\s*(\d+)/.exec(scopeEntry);
                const scopeId = scopeMatch ? parseInt(scopeMatch[1], 10) : 0;
                const libEntry = msg.find((m) => m.startsWith('lib:')) ?? '';
                const libIdMatch = /LibId:\s*(-?\d+)/.exec(libEntry);
                const libId = libIdMatch ? parseInt(libIdMatch[1], 10) : -1;
                this.stopState = { scriptId, threadId, scopeId, ...(libId >= 0 && { libId }) };
                const libSuffix = libId >= 0 ? `  lib:${libId}` : '';
                this.log(
                    `\u23f9 Stopped at line ${lineNum}${libSuffix}  (scriptId=${scriptId} thread=${threadId})`,
                );
                // If a step or pause command is in flight, bypass the spurious-stop
                // filter: the runtime stopped at a non-BP line as the direct result of
                // the user's action, so we must forward the event to VS Code.
                const pendingReason = this.pendingStopReason;
                this.pendingStopReason = null;
                if (pendingReason) {
                    if (!this.stopOnEntryPending) {
                        this.sendEvent(new StoppedEvent(pendingReason, threadId));
                    }
                    this.retryPendingBreakpoints();
                    return;
                }
                // Spurious stop filter: if the stopped line has no registered BP in our
                // registry (e.g. WinCC OA fired a queued stop for a just-removed BP),
                // auto-continue without emitting a StoppedEvent.
                // Only applies to main-script stops (libId === -1) and only when we know
                // the scriptId → source path mapping.
                if (!this.stopOnEntryPending && libId < 0) {
                    const registeredPath = this.scriptIdToPath.get(scriptId);
                    if (registeredPath !== undefined && this.bpRegistry.has(registeredPath)) {
                        const registeredLines = this.bpRegistry.get(registeredPath)!;
                        if (!registeredLines.includes(lineNum)) {
                            this.log(
                                `\u26a1 Spurious stop at line ${lineNum} (scriptId=${scriptId}) — BP removed, auto-continuing`,
                            );
                            this.client?.sendCommand('cont').catch(() => {});
                            return;
                        }
                    }
                }
                // When stopOnEntry is pending, configurationDoneRequest will emit
                // StoppedEvent('entry') after VS Code has processed the initial
                // breakpoint list. Suppress the StoppedEvent here to avoid sending
                // it before the attachRequest response (out-of-order DAP events
                // confuse VS Code, causing extra Continue presses).
                if (!this.stopOnEntryPending) {
                    this.sendEvent(new StoppedEvent('breakpoint', threadId));
                }
                // Retry any pending breakpoints (e.g. library files loaded via #uses
                // that weren't visible in 'info scripts' during initial setup).
                this.retryPendingBreakpoints();
            }
            return;
        }

        // Legacy format (used in unit tests and for forward compat)
        if (msg[0] === 'stopped') {
            const reason = msg[1] ?? 'breakpoint';
            const threadId =
                parseInt(msg[2] ?? `${this.CTRL_THREAD_ID}`, 10) || this.CTRL_THREAD_ID;
            this.log(`Stop event: reason="${reason}" thread=${threadId}`);
            this.sendEvent(new StoppedEvent(reason, threadId));
        } else if (msg[0] === 'output') {
            this.sendEvent(new OutputEvent(msg.slice(1).join('\n') + '\n', 'stdout'));
        }
    }

    /**
     * Parse "info threads" response into Thread objects.
     *
     * Handles both GDB-like "[*] <id>  Thread <name>" and WinCC OA format
     * "ThreadId: N (stopped) main" or "ThreadId: N (running) main".
     * Falls back to a single default CTRL thread on parse failure.
     */
    private parseThreads(result: string[]): Thread[] {
        const threads: Thread[] = [];
        for (const line of result) {
            // WinCC OA format: "ThreadId: N (stopped) main" or "ThreadId: N (running) name"
            const wcMatch = /ThreadId:\s*(\d+)\s+\(\w+\)\s+(.+)/.exec(line);
            if (wcMatch) {
                threads.push(new Thread(parseInt(wcMatch[1], 10), wcMatch[2].trim()));
                continue;
            }
            // GDB-like format: "* 1  Thread main"
            const gdbMatch = /\*?\s*(\d+)\s+Thread\s+(.+)/.exec(line);
            if (gdbMatch) {
                threads.push(new Thread(parseInt(gdbMatch[1], 10), gdbMatch[2].trim()));
            }
        }
        return threads.length > 0 ? threads : [new Thread(this.CTRL_THREAD_ID, 'CTRL Manager')];
    }

    /**
     * Parse "bt" (backtrace) response into StackFrame objects.
     *
     * Handles both GDB-like "#<id>  <func>() at <file>:<line>" and
     * WinCC OA 3.21 real format: "<funcSignature> at <absPath>:<line>"
     * e.g. "void main() at /home/.../loop_test.ctl:26"
     */
    private parseStackFrames(result: string[]): StackFrame[] {
        const frames: StackFrame[] = [];
        for (const line of result) {
            // GDB format: "#N  funcName (...) at file:line"
            const gdbMatch = /^#(\d+)\s+(\S+)(?:\s*\(.*?\))?\s+at\s+(.+):(\d+)/.exec(line);
            if (gdbMatch) {
                const frameId = parseInt(gdbMatch[1], 10);
                const funcName = gdbMatch[2];
                const filePath = this.toVSCodePath(gdbMatch[3].trim());
                const lineNum = parseInt(gdbMatch[4], 10);
                const fileName = filePath.split('/').pop() ?? filePath;
                frames.push(
                    new StackFrame(frameId, funcName, new Source(fileName, filePath), lineNum, 0),
                );
                continue;
            }
            // WinCC OA real format: "funcSignature at /abs/path.ctl:N"
            // e.g. "void main() at /home/testus/.../scripts/loop_test.ctl:26"
            const wcMatch = /^(.+?)\s+at\s+(.+):(\d+)$/.exec(line);
            if (wcMatch) {
                const funcName = wcMatch[1].trim();
                const filePath = this.toVSCodePath(wcMatch[2].trim());
                const lineNum = parseInt(wcMatch[3], 10);
                const fileName = filePath.split('/').pop() ?? filePath;
                frames.push(
                    new StackFrame(
                        frames.length,
                        funcName,
                        new Source(fileName, filePath),
                        lineNum,
                        0,
                    ),
                );
            }
        }
        return frames;
    }

    /**
     * Parse "info thread" response into Variable objects.
     *
     * WinCC OA 3.21 format (JSON per variable):
     *   {"const":0,"name":"counter","value":{"type":"int","varType":327680,"finalType":"int","value":7}}
     * Legacy fallback format: "varName = value"
     */
    /**
     * Format a scalar (primitive or string) for display.
     * Strings are wrapped in double quotes; other primitives use String().
     */
    private formatScalar(value: unknown): string {
        if (typeof value === 'string') return `"${value}"`;
        return String(value ?? '');
    }

    /**
     * Unwrap a single WinCC OA value object into DAP display fields.
     *
     * WinCC OA 3.21 value object shapes (confirmed from live adapter logs):
     *   Scalar:  {"type":"int","varType":N,"finalType":"int","value":42}
     *   String:  {"type":"string","varType":N,"finalType":"string","value":"hello"}
     *   dyn_*:   {"type":"dyn_int","varType":N,"finalType":"dyn_int",
     *              "value":[<valueObj>,<valueObj>,...]}
     *   mapping: {"type":"mapping","varType":N,"finalType":"mapping",
     *              "value":[{"key":"k","val":<valueObj>},...]}
     */
    private unwrapValue(inner: Record<string, unknown>): {
        displayVal: string;
        varRef: number;
        indexedVariables?: number;
        namedVariables?: number;
    } {
        const type = inner.type as string | undefined;
        const rawValue = inner.value;

        // ── mapping ───────────────────────────────────────────────────────────
        if (type === 'mapping' && Array.isArray(rawValue)) {
            const entries = rawValue as Array<{ key?: unknown; val?: unknown }>;
            const len = entries.length;
            const children = entries.map((entry) => {
                const keyName = String(entry.key ?? '');
                const valObj = entry.val as Record<string, unknown> | null | undefined;
                if (valObj && typeof valObj === 'object' && !Array.isArray(valObj)) {
                    const c = this.unwrapValue(valObj);
                    return new Variable(keyName, c.displayVal, c.varRef, c.indexedVariables, c.namedVariables);
                }
                return new Variable(keyName, this.formatScalar(entry.val), 0);
            });
            const varRef = len > 0 ? this.allocVarHandle({ type: 'children', children }) : 0;
            return { displayVal: `{${len}}`, varRef, namedVariables: len };
        }

        // ── struct (user-defined type): array of {const, name, value} field objects ──
        if (Array.isArray(rawValue) && type !== 'mapping') {
            const items = rawValue as Array<Record<string, unknown>>;
            if (items.length > 0 && typeof items[0].name === 'string') {
                const children = items.map((field) => {
                    const fieldName = String(field.name ?? '');
                    const valObj = field.value as Record<string, unknown> | null | undefined;
                    if (valObj && typeof valObj === 'object' && !Array.isArray(valObj)) {
                        const c = this.unwrapValue(valObj);
                        return new Variable(fieldName, c.displayVal, c.varRef, c.indexedVariables, c.namedVariables);
                    }
                    return new Variable(fieldName, this.formatScalar(field.value), 0);
                });
                const len = children.length;
                const varRef = len > 0 ? this.allocVarHandle({ type: 'children', children }) : 0;
                return { displayVal: `{${len}}`, varRef, namedVariables: len };
            }
        }

        // ── dyn_* (array of value objects) ───────────────────────────────────
        if (Array.isArray(rawValue)) {
            const arr = rawValue as unknown[];
            const len = arr.length;
            const children = arr.map((item, i) => {
                if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
                    const c = this.unwrapValue(item as Record<string, unknown>);
                    return new Variable(`[${i}]`, c.displayVal, c.varRef, c.indexedVariables, c.namedVariables);
                }
                // Defensive fallback: plain primitive in array
                return new Variable(`[${i}]`, this.formatScalar(item), 0);
            });
            const varRef = len > 0 ? this.allocVarHandle({ type: 'children', children }) : 0;
            return { displayVal: `[${len}]`, varRef, indexedVariables: len };
        }

        // ── string ────────────────────────────────────────────────────────────
        if (typeof rawValue === 'string') {
            return { displayVal: `"${rawValue}"`, varRef: 0 };
        }

        // ── scalar (int, uint, float, double, bool, anytype) ──────────────────
        return { displayVal: String(rawValue ?? ''), varRef: 0 };
    }

    /**
     * Parse 'info thread' (or 'print') JSON lines into DAP Variable objects.
     *
     * WinCC OA 3.21 format (confirmed from live adapter logs):
     *   {"const":0,"name":"vi","value":{"type":"int","varType":327680,"finalType":"int","value":42}}
     *
     * For dyn_* types, value.value is an array of nested value objects.
     * For mapping, value.value is an array of {"key":"k","val":{...}} objects.
     */
    private parseVariables(result: string[]): Variable[] {
        const variables: Variable[] = [];
        for (const line of result) {
            // Try JSON format first (WinCC OA 3.21)
            try {
                const obj = JSON.parse(line) as Record<string, unknown>;
                if (!obj || typeof obj.name !== 'string' || !obj.name) continue;

                const inner = obj.value as Record<string, unknown> | null | undefined;
                if (inner === null || inner === undefined || typeof inner !== 'object') {
                    variables.push(new Variable(obj.name, String(obj.value ?? ''), 0));
                    continue;
                }

                const { displayVal, varRef, indexedVariables, namedVariables } =
                    this.unwrapValue(inner);
                variables.push(
                    new Variable(obj.name, displayVal, varRef, indexedVariables, namedVariables),
                );
            } catch {
                // Legacy fallback: "varName = value"
                const eqIdx = line.indexOf(' = ');
                if (eqIdx !== -1) {
                    const name = line.substring(0, eqIdx).trim();
                    const value = line.substring(eqIdx + 3).trim();
                    variables.push(new Variable(name, value, 0));
                }
            }
        }
        return variables;
    }

    /**
     * Select the stopped script and thread so that 'bt', 'info thread', and
     * 'print' commands work. Must be called before any query command after a
     * stop event. WinCC OA requires explicit 'script N' + 'thread N' selection.
     */
    private async attachToStopContext(client: DatapointClient): Promise<void> {
        if (!this.stopState) return;
        await client.sendCommand(`script ${this.stopState.scriptId}`);
        await client.sendCommand(`thread ${this.stopState.threadId}`);
    }

    /**
     * Delete all WinCC OA breakpoints and re-set every entry in bpRegistry.
     * Eliminates stale/duplicate BPs that accumulate on repeated setBreakpoints calls.
     */
    private async reapplyAllBreakpoints(
        client: DatapointClient,
        infoResult: string[],
    ): Promise<void> {
        await client.sendCommand('delete-all');
        for (const [filePath, lines] of this.bpRegistry) {
            const basename = path.basename(filePath);
            const sid = this.findScriptId(infoResult, basename);
            if (sid !== -1) {
                this.scriptIdToPath.set(sid, filePath);
            }
            for (const line of lines) {
                try {
                    let cmd: string;
                    if (sid !== -1) {
                        cmd = `breakpoint ${JSON.stringify({ scriptId: sid, scopeId: 0, lib: -1, line })}`;
                    } else {
                        const cached = this.libIndexCache.get(basename);
                        if (!cached) continue; // pending — will be retried on next stop
                        cmd = `breakpoint ${JSON.stringify({ scriptId: cached.scriptId, scopeId: 0, lib: cached.libIndex, line })}`;
                    }
                    const r = await client.sendCommand(cmd);
                    this.log(
                        `\u25cf BP ${r[0] === 'breakpoint set' ? 'set' : 'FAILED'}: ${basename}:${line}`,
                    );
                } catch {
                    // ignore — will surface as FAILED on next reapply
                }
            }
        }
    }

    /**
     * Factory method for creating a DatapointClient.
     * Overridable in tests to inject a mock client.
     */
    protected createDatapointClient(config: DatapointConfig): DatapointClient {
        return new DatapointClient(config);
    }

    /** Disconnect and clean up the DatapointClient */
    private async cleanupClient(): Promise<void> {
        if (this.pendingBpRetryTimer) {
            clearInterval(this.pendingBpRetryTimer);
            this.pendingBpRetryTimer = undefined;
        }
        if (this.client) {
            const c = this.client;
            this.client = null;
            // Resume CTRL and clear breakpoints so the next session doesn't
            // find CTRL stuck at a breakpoint or with stale breakpoints set.
            await c.sendCommand('delete-all', 1000).catch(() => {});
            await c.sendCommand('cont', 1000).catch(() => {});
            await c.disconnect().catch(() => {
                /* ignore disconnect errors during cleanup */
            });
        }
        this.varHandles.clear();
        this.varHandleCounter = 1000;
    }

    // =========================================================================
    // DAP Request Handlers
    // =========================================================================

    /**
     * Initialize request — first request from VS Code.
     * Responds with adapter capabilities. Does NOT send InitializedEvent here;
     * InitializedEvent is sent after successful connection in attachRequest so
     * that VS Code waits until we are connected before sending breakpoints.
     */
    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        _args: DebugProtocol.InitializeRequestArguments,
    ): void {
        response.body = response.body ?? {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsStepBack = false;
        response.body.supportsSetVariable = false;
        response.body.supportsRestartFrame = false;
        response.body.supportsGotoTargetsRequest = false;
        response.body.supportsStepInTargetsRequest = false;
        response.body.supportsCompletionsRequest = false;
        response.body.completionTriggerCharacters = [];
        response.body.supportsModulesRequest = false;
        response.body.supportsRestartRequest = false;
        response.body.supportsExceptionOptions = false;
        response.body.supportsValueFormattingOptions = false;
        response.body.supportsExceptionInfoRequest = false;
        response.body.supportTerminateDebuggee = true;
        response.body.supportSuspendDebuggee = true;
        response.body.supportsDelayedStackTraceLoading = false;
        response.body.supportsLoadedSourcesRequest = false;
        response.body.supportsLogPoints = false;
        response.body.supportsTerminateThreadsRequest = false;
        response.body.supportsSetExpression = false;
        response.body.supportsTerminateRequest = true;
        response.body.supportsDataBreakpoints = false;
        response.body.supportsReadMemoryRequest = false;
        response.body.supportsWriteMemoryRequest = false;
        response.body.supportsDisassembleRequest = false;
        response.body.supportsCancelRequest = false;
        response.body.supportsBreakpointLocationsRequest = false;
        response.body.supportsClipboardContext = false;
        response.body.supportsSteppingGranularity = false;
        response.body.supportsInstructionBreakpoints = false;
        response.body.supportsExceptionFilterOptions = false;
        response.body.supportsSingleThreadExecutionRequests = false;
        this.sendResponse(response);
    }

    /**
     * Launch request.
     *
     * In WinCC OA debugging, scripts must be registered as pmon managers (in config/progs)
     * and started by pmon before debugging can begin. There is no spawn-based launch.
     * Both launchRequest and attachRequest therefore do the same thing: connect to the
     * debug DPs of an already-running CTRL manager.
     *
     * To start a manager for debugging:
     *   1. Add it to config/progs: WCCOActrl | manual | 30 | 3 | 1 | -num 5 loop.ctl
     *   2. Start it via pmon, the MCP server, or the WinCC OA Project Admin extension.
     *   3. Then launch/attach this debug adapter with manager.number = 5.
     */
    protected launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: LaunchRequestArguments,
    ): void {
        this.doAttach(response, args);
    }

    /**
     * Attach request — connect to a running WinCC OA manager via DatapointClient.
     * Sends InitializedEvent after successful connection so that VS Code sends
     * breakpoint configuration only once we are ready.
     */
    protected attachRequest(
        response: DebugProtocol.AttachResponse,
        args: AttachRequestArguments,
    ): void {
        this.doAttach(response, args);
    }

    private doAttach(
        response: DebugProtocol.LaunchResponse | DebugProtocol.AttachResponse,
        args: LaunchRequestArguments | AttachRequestArguments,
    ): void {
        this.trace = args.trace ?? false;
        this.pathMappings = args.pathMappings ?? {};

        // system = WinCC OA system name (e.g. 'System1') — used as DP prefix:
        //   'System1:_CtrlDebug_CTRL_1.Result'
        // project = WinCC OA project name (e.g. 'DevEnv3.21') — passed as -proj arg.
        //   Defaults to system name if not set (single-system setups where they match).
        const system = args.system ?? 'System1';
        const project = args.project ?? system;
        const host = args.host ?? 'localhost';
        const port = args.port ?? 4999;
        const managerType = args.manager?.type ?? 'CTRL';
        const managerNumber = args.manager?.number ?? 1;
        const stopOnEntry = (args as AttachRequestArguments).stopOnEntry ?? false;

        const config: DatapointConfig = {
            system,
            host,
            port,
            managerType,
            managerNumber,
            // answerOnConnect=true: WinCC OA fires the dpConnect callback immediately
            // with the current DP value. Required for stopOnEntry / DebugBreak(): the
            // script may have already stopped before the adapter connected.
            answerOnConnect: stopOnEntry,
            // DO NOT inject connectionArgs here.
            // The adapter is always started via bootstrap.js which establishes the
            // WinCC OA connection (ConnectionBinding.start()) before our code runs.
            // Injecting connectionArgs would overwrite process.argv and cause a
            // second WinccoaManager to try to re-register — connection already live.
        };

        if (stopOnEntry) {
            this.stopOnEntryPending = true;
        }

        this.log(
            `Connecting to ${host}:${port} project=${project} system=${system} manager=${managerType}:${managerNumber}` +
                (stopOnEntry ? ' [stopOnEntry]' : ''),
        );

        const client = this.createDatapointClient(config);
        this.client = client;

        client.on('message', (msg: string[]) => this.handleUnsolicitedMessage(msg));
        client.on('error', (err: Error) => {
            this.sendEvent(new OutputEvent(`WinCC OA debugger error: ${err.message}\n`, 'stderr'));
        });
        client.on('disconnected', () => {
            this.log('Disconnected from WinCC OA');
            this.sendEvent(new TerminatedEvent());
        });

        client
            .connect()
            .then(() => {
                this.log(`Connected. Debug DP: ${client.getDebugDp()}`);
                if (stopOnEntry) {
                    // Script is paused at DebugBreak(). Do NOT resume here.
                    // answerOnConnect=true ensures the stop event is delivered by
                    // dpConnect immediately. configurationDoneRequest will fire
                    // StoppedEvent after VS Code finishes sending breakpoints.
                    return Promise.resolve();
                }
                // Normal attach: resume if CTRL is paused from a previous session.
                // Short timeout: if already running, cont has no response.
                return client.sendCommand('cont', 500).catch(() => {});
            })
            .then(() => {
                // Clear any stale breakpoints from previous sessions before
                // VS Code sends the new breakpoint configuration.
                return client.sendCommand('delete-all').catch(() => {});
            })
            .then(() => {
                // Respond first, then send InitializedEvent so VS Code knows
                // we are ready to receive configuration (breakpoints, etc.)
                this.sendResponse(response);
                this.sendEvent(new InitializedEvent());
            })
            .catch((err: Error) => {
                this.log(`Connect failed: ${err.message}`);
                this.stopOnEntryPending = false;
                this.client = null;
                response.success = false;
                response.message = err.message;
                this.sendResponse(response);
            });
    }

    /**
     * Configuration done — VS Code has finished sending the initial breakpoint list.
     *
     * Normal attach: emit ContinuedEvent so VS Code shows the "running" state.
     * stopOnEntry: emit StoppedEvent so VS Code pauses at DebugBreak(). The
     * stop event was already delivered via answerOnConnect during connect().
     */
    protected configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        _args: DebugProtocol.ConfigurationDoneArguments,
    ): void {
        this.sendResponse(response);
        if (this.stopOnEntryPending) {
            this.stopOnEntryPending = false;
            const threadId = this.stopState?.threadId ?? this.CTRL_THREAD_ID;
            this.log(
                `stopOnEntry: sending StoppedEvent (thread=${threadId}, stopState=${this.stopState != null})`,
            );
            this.sendEvent(new StoppedEvent('entry', threadId));
        } else {
            this.sendEvent(new ContinuedEvent(this.CTRL_THREAD_ID));
            // Start timer to retry pending BPs in case info scripts was empty
            // during setBreakpoints (CTRL script started too recently).
            this.startPendingBpRetryTimer();
        }
    }

    /**
     * Set breakpoints for a source file.
     *
     * WinCC OA uses numeric scriptIds (not file paths) for its breakpoint command.
     * We first call "info scripts" to discover the integer scriptId for our file,
     * then set each breakpoint with:
     *   breakpoint {"scriptId": N, "line": M}
     * Expected response[0]: "breakpoint set" on success.
     */
    protected setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments,
    ): void {
        const sourcePath = args.source.path ?? args.source.name ?? '';
        const requestedBps = args.breakpoints ?? [];

        // Always keep registry in sync, even before connected
        if (requestedBps.length > 0) {
            this.bpRegistry.set(
                sourcePath,
                requestedBps.map((bp) => bp.line),
            );
        } else {
            this.bpRegistry.delete(sourcePath);
            this.pendingBpRequests.delete(sourcePath);
        }

        if (!this.client?.isConnected()) {
            // Return unverified — VS Code will re-request once connected
            response.body = {
                breakpoints: requestedBps.map((bp) => new Breakpoint(false, bp.line)),
            };
            this.sendResponse(response);
            return;
        }

        const client = this.client;
        const scriptBasename = path.basename(sourcePath);

        const work = async () => {
            // Fetch current script list (retry to cover the ~300ms connect window)
            let infoResult: string[] = [];
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, 200));
                if (!client.isConnected()) break;
                try {
                    infoResult = await client.sendCommand('info scripts');
                    if (infoResult.length > 0) break;
                } catch {
                    /* retry */
                }
            }

            // Library files (loaded via #uses) never appear in 'info scripts'.
            // Probing for the lib index here by issuing a real breakpoint command has a
            // side-effect: WinCC OA creates the BP, but the subsequent delete-all in
            // reapplyAllBreakpoints does NOT reliably remove lib-index BPs.  The
            // reapply then adds the lib BP a second time, producing duplicate BPs that
            // fire twice per iteration at the calling line.
            //
            // Instead, defer library-file BPs to pendingBpRequests.
            // retryPendingBreakpoints(), called on every stop event, performs the same
            // probe but uses direct sendCommand (no delete-all + reapply), so only ONE
            // BP is ever set.  This is safe because there is always at least one
            // main-script stop (from the other BPs) before the library is entered.
            //
            // The only remaining upfront use of findScriptId: distinguish main-script
            // files (scriptId ≥ 0) from library files (scriptId === -1) for the
            // reapply path below.
            const scriptId = this.findScriptId(infoResult, scriptBasename);

            // delete-all + re-set every registered BP so no stale duplicates remain
            await this.reapplyAllBreakpoints(client, infoResult);

            if (requestedBps.length === 0) {
                response.body = { breakpoints: [] };
                this.sendResponse(response);
                return;
            }

            const sidFinal = this.findScriptId(infoResult, scriptBasename);
            const cachedLib = this.libIndexCache.get(scriptBasename);

            if (sidFinal === -1 && !cachedLib) {
                // Still unknown — store as pending for retry on next stop event
                this.log(`Script "${scriptBasename}" not found — storing as pending`);
                const bps = requestedBps.map((bp) => {
                    const b = new Breakpoint(false, bp.line);
                    return { bp: b, line: bp.line };
                });
                this.pendingBpRequests.set(sourcePath, bps);
                response.body = { breakpoints: bps.map((b) => b.bp) };
                this.sendResponse(response);
                return;
            }

            // BPs were applied by reapplyAllBreakpoints — report verified for this file
            this.pendingBpRequests.delete(sourcePath);
            response.body = {
                breakpoints: requestedBps.map((bp) => new Breakpoint(true, bp.line)),
            };
            this.sendResponse(response);
        };

        // Serialize all BP operations: VS Code sends concurrent setBreakpoints
        // requests (one per file). Without serialization the concurrent
        // delete-all + reapply sequences race and create duplicate BPs in WinCC OA.
        this.bpOperationQueue = this.bpOperationQueue
            .then(() => work())
            .catch((err: Error) => {
                this.log(`setBreakpoints error: ${err.message}`);
                response.body = {
                    breakpoints: requestedBps.map((bp) => new Breakpoint(false, bp.line)),
                };
                this.sendResponse(response);
            });
    }

    /**
     * Start a 500 ms interval that calls retryPendingBreakpoints() until all
     * pending BPs are resolved or the client disconnects.
     * Safe to call multiple times — only one timer runs at a time.
     */
    private startPendingBpRetryTimer(): void {
        if (this.pendingBpRetryTimer) return;
        this.pendingBpRetryTimer = setInterval(() => {
            if (!this.client?.isConnected() || this.pendingBpRequests.size === 0) {
                clearInterval(this.pendingBpRetryTimer);
                this.pendingBpRetryTimer = undefined;
                return;
            }
            this.retryPendingBreakpoints();
        }, 500);
    }

    private retryPendingBreakpoints(): void {
        if (!this.client?.isConnected() || this.pendingBpRequests.size === 0) return;
        if (this.pendingBpRetryInFlight) return;
        this.pendingBpRetryInFlight = true;

        const client = this.client;
        const snapshot = new Map(this.pendingBpRequests);

        const work = async () => {
            try {
                let infoResult: string[];
                try {
                    infoResult = await client.sendCommand('info scripts', 3000);
                } catch {
                    return;
                }

                for (const [sourcePath, bpList] of snapshot) {
                    const scriptBasename = path.basename(sourcePath);
                    const scriptId = this.findScriptId(infoResult, scriptBasename);

                    if (scriptId !== -1) {
                        // Found in info scripts (non-library main script)
                        this.pendingBpRequests.delete(sourcePath);
                        this.log(
                            `Pending BPs for "${scriptBasename}" now settable (scriptId=${scriptId})`,
                        );
                        for (const { bp, line } of bpList) {
                            const cmd = `breakpoint ${JSON.stringify({ scriptId, scopeId: 0, lib: -1, line })}`;
                            client
                                .sendCommand(cmd)
                                .then((res) => {
                                    if (res[0] === 'breakpoint set') {
                                        bp.verified = true;
                                        this.sendEvent(new BreakpointEvent('changed', bp));
                                        this.log(`Pending BP verified: ${scriptBasename}:${line}`);
                                    }
                                })
                                .catch(() => {});
                        }
                        continue;
                    }

                    // Not in info scripts — try lib:N probing (for #uses libraries)
                    if (bpList.length === 0) continue;
                    let cached = this.libIndexCache.get(scriptBasename);
                    if (cached === undefined) {
                        const allIds = this.getAllScriptIds(infoResult);
                        outer: for (const sid of allIds) {
                            for (let probe = 0; probe < WinCCDebugSession.MAX_LIB_PROBE; probe++) {
                                if (!client.isConnected()) break outer;
                                try {
                                    const probeCmd = `breakpoint ${JSON.stringify({ scriptId: sid, scopeId: 0, lib: probe, line: bpList[0].line })}`;
                                    const probeRes = await client.sendCommand(probeCmd, 500);
                                    if (probeRes[0] === 'breakpoint set') {
                                        cached = { scriptId: sid, libIndex: probe };
                                        this.libIndexCache.set(scriptBasename, cached);
                                        this.log(
                                            `Pending lib "${scriptBasename}" found at scriptId:${sid} lib:${probe}`,
                                        );
                                        break outer;
                                    }
                                } catch {
                                    // probe timed out or errored — try next
                                }
                            }
                        }
                    }
                    if (cached === undefined) continue;

                    // Lib index found — first BP was set via probe; set remaining
                    const { scriptId: libSid, libIndex } = cached;
                    this.pendingBpRequests.delete(sourcePath);
                    bpList[0].bp.verified = true;
                    this.sendEvent(new BreakpointEvent('changed', bpList[0].bp));
                    for (let i = 1; i < bpList.length; i++) {
                        const { bp, line } = bpList[i];
                        const cmd = `breakpoint ${JSON.stringify({ scriptId: libSid, scopeId: 0, lib: libIndex, line })}`;
                        client
                            .sendCommand(cmd)
                            .then((res) => {
                                if (res[0] === 'breakpoint set') {
                                    bp.verified = true;
                                    this.sendEvent(new BreakpointEvent('changed', bp));
                                    this.log(`Pending lib BP verified: ${scriptBasename}:${line}`);
                                }
                            })
                            .catch(() => {});
                    }
                }
            } finally {
                this.pendingBpRetryInFlight = false;
            }
        };

        work().catch(() => {
            this.pendingBpRetryInFlight = false;
        });
    }

    /**
     * Search 'info scripts' response for a script matching the given basename.
     * Each entry in the result looks like:
     *   "ScriptId: N; current thread: T; scripts/fileName.ctl"  (relative)
     *   "ScriptId: N; current thread: T; /full/path/fileName.ctl" (absolute)
     * Returns -1 when not found.
     */
    private findScriptId(result: string[], basename: string): number {
        const lowerName = basename.toLowerCase();
        for (const line of result) {
            if (!line.includes('ScriptId:')) continue;
            if (line.toLowerCase().includes(lowerName)) {
                const m = /ScriptId:\s*(\d+)/.exec(line);
                if (m) return parseInt(m[1], 10);
            }
        }
        return -1;
    }

    /** Extract all ScriptIds from an 'info scripts' response. */
    private getAllScriptIds(result: string[]): number[] {
        const ids: number[] = [];
        for (const line of result) {
            const m = /ScriptId:\s*(\d+)/.exec(line);
            if (m) ids.push(parseInt(m[1], 10));
        }
        return ids;
    }

    /**
     * Continue execution.
     * WinCC OA command: "cont"
     *
     * IMPORTANT: Send ContinueResponse BEFORE the WinCC OA command.
     * WinCC OA uses the last command's ID to deliver the next stop event
     * (it does not send a separate unsolicited event). If we wait for `cont`
     * to resolve before sending ContinueResponse, the StoppedEvent from
     * handleResponse arrives while VS Code is still in PAUSED state — which
     * causes VS Code to ignore or mis-sequence the event, requiring 3 extra
     * Continue presses per breakpoint.
     * Sending the response first ensures VS Code transitions to RUNNING before
     * the next StoppedEvent arrives.
     */
    protected continueRequest(
        response: DebugProtocol.ContinueResponse,
        _args: DebugProtocol.ContinueArguments,
    ): void {
        this.log('▶ Continue');
        response.body = { allThreadsContinued: true };
        this.sendResponse(response);
        if (this.client?.isConnected()) {
            this.client.sendCommand('cont').catch(() => {});
        }
    }

    /**
     * Step over (next line, do not enter function calls).
     * WinCC OA command: "step over"  (from CTRLdebugger.ctl constants)
     *
     * Send response first (same reasoning as continueRequest) so VS Code
     * transitions to RUNNING before the resulting StoppedEvent arrives.
     */
    protected nextRequest(
        response: DebugProtocol.NextResponse,
        _args: DebugProtocol.NextArguments,
    ): void {
        this.log('→ Step Over');
        this.sendResponse(response);
        if (this.client?.isConnected()) {
            this.pendingStopReason = 'step';
            this.attachToStopContext(this.client)
                .catch((e: Error) => { this.log(`attachToStopContext error: ${e.message}`); })
                .then(() => {
                    return this.client?.sendCommand('step over')
                        .catch((e: Error) => { this.log(`step over error: ${e.message}`); });
                });
        }
    }

    /**
     * Step into function call.
     * WinCC OA command: "step in"  (from CTRLdebugger.ctl constants)
     *
     * Send response first so VS Code is in RUNNING state when StoppedEvent arrives.
     */
    protected stepInRequest(
        response: DebugProtocol.StepInResponse,
        _args: DebugProtocol.StepInArguments,
    ): void {
        this.log('↓ Step Into');
        this.sendResponse(response);
        if (this.client?.isConnected()) {
            this.pendingStopReason = 'step';
            this.attachToStopContext(this.client)
                .catch((e: Error) => { this.log(`attachToStopContext error: ${e.message}`); })
                .then(() => {
                    return this.client?.sendCommand('step in')
                        .catch((e: Error) => { this.log(`step in error: ${e.message}`); });
                });
        }
    }

    /**
     * Step out of current function.
     * WinCC OA command: "step out"  (from CTRLdebugger.ctl constants)
     *
     * Send response first so VS Code is in RUNNING state when StoppedEvent arrives.
     */
    protected stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        _args: DebugProtocol.StepOutArguments,
    ): void {
        this.log('↑ Step Out');
        this.sendResponse(response);
        if (this.client?.isConnected()) {
            this.pendingStopReason = 'step';
            this.attachToStopContext(this.client)
                .catch((e: Error) => { this.log(`attachToStopContext error: ${e.message}`); })
                .then(() => {
                    return this.client?.sendCommand('step out')
                        .catch((e: Error) => { this.log(`step out error: ${e.message}`); });
                });
        }
    }

    /**
     * Pause (break) execution.
     * WinCC OA command: "b" (break/pause)
     * Requires context (script + thread) to be set first so WinCC OA knows
     * which script to pause.  Re-uses the stop context from the last stop event.
     */
    protected pauseRequest(
        response: DebugProtocol.PauseResponse,
        _args: DebugProtocol.PauseArguments,
    ): void {
        this.log('⏸ Pause');
        const work = async () => {
            if (this.client?.isConnected()) {
                this.pendingStopReason = 'pause';
                // Set script/thread context before issuing "b" so WinCC OA knows
                // which running script to pause (requires context from last stop).
                await this.attachToStopContext(this.client).catch(() => {});
                // "b" = break/pause. WinCC OA responds with the stop event data
                // (["line: N", ...]) using this command's ID.  DatapointClient
                // will re-emit it as 'message' → handleUnsolicitedMessage → StoppedEvent.
                await this.client.sendCommand('b').catch(() => {});
            }
            this.sendResponse(response);
        };
        work().catch(() => this.sendResponse(response));
    }

    /**
     * Return the list of active threads.
     * Returns the thread captured from the last stop event if available,
     * otherwise falls back to a single "CTRL Manager" thread (id=0).
     */
    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        const threadId = this.stopState?.threadId ?? this.CTRL_THREAD_ID;
        response.body = { threads: [new Thread(threadId, 'CTRL Manager')] };
        this.sendResponse(response);
    }

    /**
     * Return the call stack for a thread.
     * WinCC OA 3.21: must call 'script N' + 'thread N' first, then 'bt'.
     * Real bt format: "void main() at /abs/path/file.ctl:26"
     */
    protected stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        _args: DebugProtocol.StackTraceArguments,
    ): void {
        const work = async () => {
            if (!this.client?.isConnected()) {
                response.body = { stackFrames: [], totalFrames: 0 };
                return this.sendResponse(response);
            }
            try {
                await this.attachToStopContext(this.client);
                const result = await this.client.sendCommand('bt', 3000);
                const frames = this.parseStackFrames(result);
                response.body = { stackFrames: frames, totalFrames: frames.length };
            } catch {
                response.body = { stackFrames: [], totalFrames: 0 };
            }
            this.sendResponse(response);
        };
        work().catch(() => {
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendResponse(response);
        });
    }

    /**
     * Return the variable scopes for a stack frame.
     * Provides a single "Locals" scope backed by "info locals".
     */
    protected scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments,
    ): void {
        const ref = this.allocVarHandle({ type: 'locals', frameId: args.frameId });
        response.body = {
            scopes: [new Scope('Locals', ref, false)],
        };
        this.sendResponse(response);
    }

    /**
     * Return variables for a scope or structured variable.
     * WinCC OA 3.21: must call 'script N' + 'thread N' first, then 'info thread'.
     * Response format: JSON objects per variable.
     */
    protected variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments,
    ): void {
        const handleInfo = this.varHandles.get(args.variablesReference);

        if (!handleInfo || !this.client?.isConnected()) {
            response.body = { variables: [] };
            return this.sendResponse(response);
        }

        const client = this.client;
        const work = async () => {
            // 'children' type: children are pre-built in parseVariables — no commands needed
            if (handleInfo.type === 'children') {
                response.body = { variables: handleInfo.children ?? [] };
                return this.sendResponse(response);
            }

            await this.attachToStopContext(client);
            let result: string[];
            if (handleInfo.type === 'locals') {
                // 'info thread' returns per-thread locals as JSON objects
                result = await client.sendCommand('info thread', 3000);
            } else {
                result = await client.sendCommand(`print ${handleInfo.expression}`, 3000);
            }
            response.body = { variables: this.parseVariables(result) };
            this.sendResponse(response);
        };

        work().catch(() => {
            response.body = { variables: [] };
            this.sendResponse(response);
        });
    }

    /**
     * Evaluate an expression (hover, REPL, watch).
     * WinCC OA 3.21: requires 'script N' + 'thread N' first, then 'print <expr>'.
     * Response: JSON variable object — extract .value.value for display.
     */
    protected evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments,
    ): void {
        if (!this.client?.isConnected()) {
            response.success = false;
            response.message = 'Not connected to WinCC OA';
            return this.sendResponse(response);
        }

        const client = this.client;
        const work = async () => {
            await this.attachToStopContext(client);
            const result = await client.sendCommand(`print ${args.expression}`, 3000);
            // Try to extract a meaningful display value from JSON response
            let displayVal = '(no value)';
            for (const line of result) {
                try {
                    const obj = JSON.parse(line) as Record<string, unknown>;
                    if (obj && typeof obj === 'object' && 'value' in obj) {
                        const inner = obj.value as Record<string, unknown> | null | undefined;
                        displayVal =
                            inner !== null &&
                            inner !== undefined &&
                            typeof inner === 'object' &&
                            'value' in inner
                                ? String(inner.value)
                                : String(obj.value ?? '');
                        break;
                    }
                } catch {
                    // Non-JSON line — fallback to plain string if no JSON found
                    if (displayVal === '(no value)' && line.trim() && line !== 'OK') {
                        displayVal = line.trim();
                    }
                }
            }
            response.body = { result: displayVal, variablesReference: 0 };
            this.sendResponse(response);
        };

        work().catch((err: Error) => {
            response.body = { result: `Error: ${err.message}`, variablesReference: 0 };
            this.sendResponse(response);
        });
    }

    /**
     * Disconnect — stop debugging and release the connection.
     */
    protected disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        _args: DebugProtocol.DisconnectArguments,
    ): void {
        this.cleanupClient()
            .then(() => this.sendResponse(response))
            .catch(() => this.sendResponse(response));
    }

    /**
     * Terminate — forcibly end the debug session.
     */
    protected terminateRequest(
        response: DebugProtocol.TerminateResponse,
        _args: DebugProtocol.TerminateArguments,
    ): void {
        this.cleanupClient()
            .then(() => {
                this.sendResponse(response);
                this.sendEvent(new TerminatedEvent());
            })
            .catch(() => {
                this.sendResponse(response);
                this.sendEvent(new TerminatedEvent());
            });
    }
}
