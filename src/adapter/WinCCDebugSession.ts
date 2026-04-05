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
    type: 'locals' | 'expression';
    frameId?: number;
    expression?: string;
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
    private stopState: { scriptId: number; threadId: number; scopeId: number } | null = null;

    /**
     * Set to true when `stopOnEntry` is active. configurationDoneRequest
     * will send a StoppedEvent instead of ContinuedEvent in this case.
     */
    private stopOnEntryPending = false;

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
                this.stopState = { scriptId, threadId, scopeId };
                this.log(
                    `Stop at line ${lineNum}, thread ${threadId}, script ${scriptId}, scope ${scopeId}`,
                );
                this.sendEvent(new StoppedEvent('breakpoint', threadId));
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
    private parseVariables(result: string[]): Variable[] {
        const variables: Variable[] = [];
        for (const line of result) {
            // Try JSON format first (WinCC OA 3.21)
            try {
                const obj = JSON.parse(line) as Record<string, unknown>;
                if (obj && typeof obj.name === 'string' && obj.name) {
                    const inner = obj.value as Record<string, unknown> | null | undefined;
                    const displayVal =
                        inner !== null &&
                        inner !== undefined &&
                        typeof inner === 'object' &&
                        'value' in inner
                            ? String(inner.value)
                            : String(obj.value ?? '');
                    variables.push(new Variable(obj.name, displayVal, 0));
                }
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
     * Factory method for creating a DatapointClient.
     * Overridable in tests to inject a mock client.
     */
    protected createDatapointClient(config: DatapointConfig): DatapointClient {
        return new DatapointClient(config);
    }

    /** Disconnect and clean up the DatapointClient */
    private async cleanupClient(): Promise<void> {
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
     *   1. Add it to config/progs: WCCOActrl | manual | 30 | 3 | 1 | -num 5 -f scripts/loop.ctl
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
            this.log(`stopOnEntry: sending StoppedEvent (thread=${threadId}, stopState=${this.stopState != null})`);
            this.sendEvent(new StoppedEvent('entry', threadId));
        } else {
            this.sendEvent(new ContinuedEvent(this.CTRL_THREAD_ID));
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
            // Query the loaded scripts list to get the numeric scriptId.
            // WinCC OA identifies scripts by integer ID, not by file path.
            // Retry up to 3 times with 200ms gaps (covers the ~300ms connect
            // window + time for the script to begin execution and appear in
            // 'info scripts' output). Keep low to avoid blocking the session
            // when VS Code has stale breakpoints for non-existent scripts.
            let scriptId = -1;
            const maxAttempts = 3;
            for (let attempt = 0; attempt < maxAttempts && scriptId === -1; attempt++) {
                if (attempt > 0) {
                    await new Promise<void>((resolve) => setTimeout(resolve, 200));
                }
                if (!client.isConnected()) break;
                try {
                    const infoResult = await client.sendCommand('info scripts');
                    scriptId = this.findScriptId(infoResult, scriptBasename);
                } catch {
                    // ignore, retry
                }
            }

            if (scriptId === -1) {
                this.log(
                    `Script "${scriptBasename}" not found via info scripts — returning unverified`,
                );
                response.body = {
                    breakpoints: requestedBps.map((bp) => new Breakpoint(false, bp.line)),
                };
                this.sendResponse(response);
                return;
            }

            const breakpoints: Breakpoint[] = [];
            for (const bp of requestedBps) {
                try {
                    // scopeId:0 and lib:-1 are required by WinCC OA 3.21 —
                    // without them the engine accepts the command but never fires a stop event.
                    const cmd = `breakpoint ${JSON.stringify({ scriptId, scopeId: 0, lib: -1, line: bp.line })}`;
                    const result = await client.sendCommand(cmd);
                    // WinCC OA responds with "breakpoint set" on success
                    const verified = result[0] === 'breakpoint set';
                    breakpoints.push(new Breakpoint(verified, bp.line));
                } catch {
                    breakpoints.push(new Breakpoint(false, bp.line));
                }
            }
            response.body = { breakpoints };
            this.sendResponse(response);
        };

        work().catch((err: Error) => {
            this.log(`setBreakpoints error: ${err.message}`);
            response.body = {
                breakpoints: requestedBps.map((bp) => new Breakpoint(false, bp.line)),
            };
            this.sendResponse(response);
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

    /**
     * Continue execution.
     * WinCC OA command: "cont"
     */
    protected continueRequest(
        response: DebugProtocol.ContinueResponse,
        _args: DebugProtocol.ContinueArguments,
    ): void {
        const work = async () => {
            if (this.client?.isConnected()) {
                await this.client.sendCommand('cont').catch(() => {});
            }
            response.body = { allThreadsContinued: true };
            this.sendResponse(response);
        };
        work().catch(() => {
            response.body = { allThreadsContinued: true };
            this.sendResponse(response);
        });
    }

    /**
     * Step over (next line, do not enter function calls).
     * WinCC OA command: "step over"
     * The resulting stop is delivered as an unsolicited stop event.
     */
    protected nextRequest(
        response: DebugProtocol.NextResponse,
        _args: DebugProtocol.NextArguments,
    ): void {
        const work = async () => {
            if (this.client?.isConnected()) {
                await this.attachToStopContext(this.client).catch(() => {});
                await this.client.sendCommand('step over').catch(() => {});
            }
            this.sendResponse(response);
        };
        work().catch(() => this.sendResponse(response));
    }

    /**
     * Step into function call.
     * WinCC OA command: "step in"
     */
    protected stepInRequest(
        response: DebugProtocol.StepInResponse,
        _args: DebugProtocol.StepInArguments,
    ): void {
        const work = async () => {
            if (this.client?.isConnected()) {
                await this.attachToStopContext(this.client).catch(() => {});
                await this.client.sendCommand('step in').catch(() => {});
            }
            this.sendResponse(response);
        };
        work().catch(() => this.sendResponse(response));
    }

    /**
     * Step out of current function.
     * WinCC OA command: "step out"
     */
    protected stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        _args: DebugProtocol.StepOutArguments,
    ): void {
        const work = async () => {
            if (this.client?.isConnected()) {
                await this.attachToStopContext(this.client).catch(() => {});
                await this.client.sendCommand('step out').catch(() => {});
            }
            this.sendResponse(response);
        };
        work().catch(() => this.sendResponse(response));
    }

    /**
     * Pause (break) execution.
     * WinCC OA command: "b" (break/pause)
     */
    protected pauseRequest(
        response: DebugProtocol.PauseResponse,
        _args: DebugProtocol.PauseArguments,
    ): void {
        const work = async () => {
            if (this.client?.isConnected()) {
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
