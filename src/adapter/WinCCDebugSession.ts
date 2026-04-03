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

import {
    DebugSession,
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
    private readonly CTRL_THREAD_ID = 1;

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
                return vscodePath.slice(local.length).replace(/\\/g, '/').replace(/^\//, '') === ''
                    ? remote
                    : remote + vscodePath.slice(local.length).replace(/\\/g, '/');
            }
        }
        return vscodePath;
    }

    /** Map a WinCC OA remote path back to the VS Code local path */
    private toVSCodePath(wccoaPath: string): string {
        for (const [local, remote] of Object.entries(this.pathMappings)) {
            if (wccoaPath.startsWith(remote)) {
                return local + wccoaPath.slice(remote.length);
            }
        }
        return wccoaPath;
    }

    /**
     * Handle unsolicited messages from WinCC OA (stop events, output, etc.).
     *
     * Expected stop format: ["stopped", reason, threadId, file?, line?]
     *   reason: "breakpoint" | "step" | "exception" | "pause" | "entry"
     *   threadId: stringified number, e.g. "1"
     *   file: optional script path, e.g. "scripts/debugTest.ctl"
     *   line: optional line number as string
     *
     * Expected output format: ["output", text]
     */
    private handleUnsolicitedMessage(msg: string[]): void {
        if (msg.length === 0) {
            return;
        }

        if (msg[0] === 'stopped') {
            const reason = msg[1] ?? 'breakpoint';
            const threadId =
                parseInt(msg[2] ?? `${this.CTRL_THREAD_ID}`, 10) || this.CTRL_THREAD_ID;
            this.log(`Stop event: reason="${reason}" thread=${threadId}`);
            const event = new StoppedEvent(reason, threadId);
            this.sendEvent(event);
        } else if (msg[0] === 'output') {
            this.sendEvent(new OutputEvent(msg.slice(1).join('\n') + '\n', 'stdout'));
        }
    }

    /**
     * Parse "info threads" response into Thread objects.
     *
     * Expected GDB-like format per line: "[*] <id>  Thread <name>"
     * e.g. "* 1  Thread main" or "  2  Thread worker"
     * Falls back to a single default CTRL thread on parse failure.
     */
    private parseThreads(result: string[]): Thread[] {
        const threads: Thread[] = [];
        for (const line of result) {
            const match = /\*?\s*(\d+)\s+Thread\s+(.+)/.exec(line);
            if (match) {
                threads.push(new Thread(parseInt(match[1], 10), match[2].trim()));
            }
        }
        return threads.length > 0 ? threads : [new Thread(this.CTRL_THREAD_ID, 'CTRL Manager')];
    }

    /**
     * Parse "bt" (backtrace) response into StackFrame objects.
     *
     * Expected GDB-like format per line:
     *   "#<id>  <funcName> (<args>) at <file>:<line>"
     * e.g. "#0  testFunction () at scripts/debugTest.ctl:29"
     */
    private parseStackFrames(result: string[]): StackFrame[] {
        const frames: StackFrame[] = [];
        for (const line of result) {
            const match = /^#(\d+)\s+(\S+)\s*(?:\(.*?\))?\s+at\s+(.+):(\d+)/.exec(line);
            if (match) {
                const frameId = parseInt(match[1], 10);
                const funcName = match[2];
                const filePath = this.toVSCodePath(match[3].trim());
                const lineNum = parseInt(match[4], 10);
                const fileName = filePath.split('/').pop() ?? filePath;
                const source = new Source(fileName, filePath);
                frames.push(new StackFrame(frameId, funcName, source, lineNum, 0));
            }
        }
        return frames;
    }

    /**
     * Parse "info locals" response into Variable objects.
     *
     * Expected format per line: "varName = value"
     * e.g. "i = 5" or "result = 120"
     */
    private parseVariables(result: string[]): Variable[] {
        const variables: Variable[] = [];
        for (const line of result) {
            const eqIdx = line.indexOf(' = ');
            if (eqIdx !== -1) {
                const name = line.substring(0, eqIdx).trim();
                const value = line.substring(eqIdx + 3).trim();
                variables.push(new Variable(name, value, 0));
            }
        }
        return variables;
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
     * Launch request — WinCC OA does not spawn new manager processes via DAP.
     * Treated identically to an attach request.
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
        // The adapter itself registers as a jscript manager in WinCC OA.
        // Use a number that is unlikely to clash with project managers.
        const adapterNum = args.adapterManagerNumber ?? 99;

        const config: DatapointConfig = {
            system,
            host,
            port,
            managerType,
            managerNumber,
            // winccoa-manager native addon reads connection params from process.argv.
            // When spawned by VS Code (not by pmon) these must be injected explicitly.
            connectionArgs: [
                '-proj',
                project,  // project name (e.g. DevEnv3.21), not the system name
                '-host',
                host,
                '-port',
                String(port),
                '-num',
                String(adapterNum),
                '-m',
                'jscript',
            ],
        };

        this.log(
            `Connecting to ${host}:${port} project=${project} system=${system} manager=${managerType}:${managerNumber} adapterNum=${adapterNum}`,
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
                // Respond first, then send InitializedEvent so VS Code knows
                // we are ready to receive configuration (breakpoints, etc.)
                this.sendResponse(response);
                this.sendEvent(new InitializedEvent());
            })
            .catch((err: Error) => {
                this.log(`Connect failed: ${err.message}`);
                this.client = null;
                response.success = false;
                response.message = err.message;
                this.sendResponse(response);
            });
    }

    /**
     * Set breakpoints for a source file.
     * Clears all existing breakpoints for the file first, then sets each one.
     *
     * WinCC OA commands used:
     *   clear <file>             — remove all breakpoints in file
     *   break <file>:<line>      — set a breakpoint
     * Expected response[0]: "OK" on success, "ERROR" on failure.
     */
    protected setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments,
    ): void {
        const sourcePath = args.source.path ?? args.source.name ?? '';
        const wccoaPath = this.toWinCCOAPath(sourcePath);
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

        const work = async () => {
            // Clear all breakpoints for this file before re-setting
            await client.sendCommand(`clear ${wccoaPath}`).catch(() => {
                /* file may not have any breakpoints yet */
            });

            const breakpoints: Breakpoint[] = [];
            for (const bp of requestedBps) {
                try {
                    const result = await client.sendCommand(`break ${wccoaPath}:${bp.line}`);
                    // result[0] is "OK" on success; also accept lines containing "Breakpoint"
                    const verified =
                        result[0] === 'OK' || result.some((r) => /breakpoint/i.test(r));
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
     * Continue execution.
     * WinCC OA command: "continue"
     */
    protected continueRequest(
        response: DebugProtocol.ContinueResponse,
        _args: DebugProtocol.ContinueArguments,
    ): void {
        const work = async () => {
            if (this.client?.isConnected()) {
                await this.client.sendCommand('continue').catch(() => {});
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
     * WinCC OA command: "next"
     * The resulting stop is delivered as an unsolicited "stopped" message.
     */
    protected nextRequest(
        response: DebugProtocol.NextResponse,
        _args: DebugProtocol.NextArguments,
    ): void {
        const work = async () => {
            if (this.client?.isConnected()) {
                await this.client.sendCommand('next').catch(() => {});
            }
            this.sendResponse(response);
        };
        work().catch(() => this.sendResponse(response));
    }

    /**
     * Step into function call.
     * WinCC OA command: "step"
     */
    protected stepInRequest(
        response: DebugProtocol.StepInResponse,
        _args: DebugProtocol.StepInArguments,
    ): void {
        const work = async () => {
            if (this.client?.isConnected()) {
                await this.client.sendCommand('step').catch(() => {});
            }
            this.sendResponse(response);
        };
        work().catch(() => this.sendResponse(response));
    }

    /**
     * Step out of current function.
     * WinCC OA command: "finish"
     */
    protected stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        _args: DebugProtocol.StepOutArguments,
    ): void {
        const work = async () => {
            if (this.client?.isConnected()) {
                await this.client.sendCommand('finish').catch(() => {});
            }
            this.sendResponse(response);
        };
        work().catch(() => this.sendResponse(response));
    }

    /**
     * Pause (break) execution.
     * WinCC OA command: "interrupt"
     */
    protected pauseRequest(
        response: DebugProtocol.PauseResponse,
        _args: DebugProtocol.PauseArguments,
    ): void {
        const work = async () => {
            if (this.client?.isConnected()) {
                await this.client.sendCommand('interrupt').catch(() => {});
            }
            this.sendResponse(response);
        };
        work().catch(() => this.sendResponse(response));
    }

    /**
     * Return the list of active threads.
     * WinCC OA command: "info threads"
     * Expected response lines: GDB-like "[*] <id>  Thread <name>"
     * Falls back to a single "CTRL Manager" thread on failure.
     */
    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        const work = async () => {
            if (this.client?.isConnected()) {
                try {
                    const result = await this.client.sendCommand('info threads', 3000);
                    response.body = { threads: this.parseThreads(result) };
                } catch {
                    response.body = { threads: [new Thread(this.CTRL_THREAD_ID, 'CTRL Manager')] };
                }
            } else {
                response.body = { threads: [new Thread(this.CTRL_THREAD_ID, 'CTRL Manager')] };
            }
            this.sendResponse(response);
        };
        work().catch(() => {
            response.body = { threads: [new Thread(this.CTRL_THREAD_ID, 'CTRL Manager')] };
            this.sendResponse(response);
        });
    }

    /**
     * Return the call stack for a thread.
     * WinCC OA command: "bt"
     * Expected response lines: GDB-like "#<id>  <func> () at <file>:<line>"
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
     * WinCC OA command: "info locals" (for a locals scope)
     * Expected response lines: "varName = value"
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
            let result: string[];
            if (handleInfo.type === 'locals') {
                result = await client.sendCommand('info locals', 3000);
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
     * WinCC OA command: "print <expression>"
     * Returns the string representation of the value.
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
            const result = await client.sendCommand(`print ${args.expression}`, 3000);
            // Filter out the leading "OK" token if present
            const value =
                result
                    .filter((r) => r !== 'OK')
                    .join('\n')
                    .trim() || '(no value)';
            response.body = { result: value, variablesReference: 0 };
            this.sendResponse(response);
        };

        work().catch((err: Error) => {
            response.body = { result: `Error: ${err.message}`, variablesReference: 0 };
            this.sendResponse(response);
        });
    }

    /**
     * Disconnect — stop debugging and release the connection.
     * Sends TerminatedEvent after cleanup.
     */
    protected disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        _args: DebugProtocol.DisconnectArguments,
    ): void {
        this.cleanupClient()
            .then(() => {
                this.sendResponse(response);
            })
            .catch(() => {
                this.sendResponse(response);
            });
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
