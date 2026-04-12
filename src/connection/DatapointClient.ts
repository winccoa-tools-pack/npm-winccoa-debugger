/**
 * DatapointClient
 *
 * Transport layer for communicating with the WinCC OA CTRL debugger.
 *
 * Responsibilities:
 * - Connect to WinCC OA as a manager via the official winccoa-manager package
 * - Send commands to _CtrlDebug_<Manager>_<Num>.Command datapoint
 * - Receive responses via dpConnect on .Result datapoint
 * - Handle connection lifecycle (connect, disconnect)
 * - Emit events for incoming messages
 *
 * Protocol:
 * - Command DPE: System1:_CtrlDebug_CTRL_1.Command (Text)
 * - Result DPE:  System1:_CtrlDebug_CTRL_1.Result (dyn_string)
 * - Commands are JSON:  { id: "timestamp-random", cmd: "break scripts/test.ctl 10" }
 * - Responses are JSON array: ["timestamp-random", "OK", ...lines]
 *
 * DPE structure is flat — no nested _CtrlDebug element.
 * The system prefix (e.g. "System1:") is always required.
 *
 * How it works:
 * The Node.js process must be started by WinCC OA pmon (as a registered manager).
 * pmon passes connection args via process.argv. The official winccoa-manager
 * package reads those automatically — no manual TCP setup needed.
 *
 * In production:  pmon starts  → node index.js -proj System1 -host ... -num 5 -m jscript
 * In unit tests:  IWinccoaManager is injected as a mock (no WinCC OA needed)
 */

import { EventEmitter } from 'events';
import path from 'path';
import {
    getWinCCOAInstallationPathByVersion,
    getAvailableWinCCOAVersions,
} from '@winccoa-tools-pack/npm-winccoa-core';

/**
 * Minimal interface matching WinccoaManager from the official winccoa-manager package.
 * Kept narrow so unit tests can inject a simple mock.
 */
export interface IWinccoaManager {
    /**
     * Subscribe to DPE value changes.
     * Official WinccoaManager callback signature: (names: string[], values: unknown[], type, error?)
     * - names[i]  = DPE name string
     * - values[i] = actual DPE value
     */
    dpConnect(
        callback: (names: string[], values: any[], type?: any, error?: any) => void,
        dpeNames: string | string[],
        answer?: boolean,
    ): number;
    /** Disconnect a dpConnect subscription by its returned id. */
    dpDisconnect(id: number): void;
    /** Write value(s) to one or more DPEs. Fire-and-forget. */
    dpSet(dpeNames: string | string[], values: any | any[]): void;
    /** Write and wait until the value is confirmed by the Data Manager. */
    dpSetWait(dpeNames: string | string[], values: any | any[]): Promise<void>;
    /** Check whether a datapoint exists. */
    dpExists(dpName: string): boolean;
    /** Create a new datapoint of the given type. Returns true on success. */
    dpCreate(dpName: string, dpType: string): Promise<boolean>;
    /**
     * Set the active user for this manager instance.
     * No password needed when the OS process runs as root.
     * User ID 1 = WinCC OA built-in root user (always exists, no auth required).
     */
    setUserId(id: number, password?: string): boolean;
    /** Look up a user ID by name. */
    getUserId(userName?: string): number | undefined;
}

/** @internal — kept for backwards compat with existing tests that check IWinccoaApi */
export type IWinccoaApi = IWinccoaManager;
/** @internal */
export interface IWinccoaConnection {
    managerStart(args: string[], api: IWinccoaManager): Promise<void>;
    prepareExit(): void;
}

export interface DatapointConfig {
    /**
     * WinCC OA system name (e.g. 'System1' or 'system1').
     * When set, DPE names are prefixed: `<system>:_CtrlDebug_CTRL_1.Result`.
     * When omitted or empty, no prefix is used: `_CtrlDebug_CTRL_1.Result`.
     * Case is preserved exactly as given — WinCC OA is case-sensitive here.
     */
    system?: string;
    /** Host address */
    host: string;
    /** Port number */
    port: number;
    /** Manager type of the CTRL manager we want to debug */
    managerType: 'CTRL' | 'UI' | 'EVENT' | 'ASCII' | 'DEVICE' | 'API' | 'DRIVER';
    /** Manager number of the CTRL manager we want to debug */
    managerNumber: number;
    /**
     * WinCC OA connection arguments to inject into process.argv before the
     * winccoa-manager singleton is initialised.
     *
     * In production the process is started by pmon, which passes these flags
     * automatically.  In integration tests – where the test runner is a plain
     * `node` process without WinCC OA args – supply them explicitly so the
     * native addon can connect:
     *
     * ```ts
     * connectionArgs: ['-proj', 'System1', '-host', 'localhost',
     *                  '-port', '4999',   '-num',  '10', '-m', 'jscript']
     * ```
     *
     * The manager number here (-num) is OUR manager number (the adapter),
     * not the CTRL manager number in `managerNumber` above.
     */
    connectionArgs?: string[];
    /**
     * When true, pass `answer=true` to the initial dpConnect on the Result DPE.
     *
     * `answer=true` fires the callback immediately with the CURRENT value of the
     * Result DPE — even if no new value has arrived since the last subscription.
     * This is required for `stopOnEntry` / `DebugBreak()` support:
     *
     * Flow without answerOnConnect:
     *   script hits DebugBreak() → Result DPE written → (adapter not yet connected)
     *   adapter connects with answer=false → misses the already-written stop event
     *
     * Flow with answerOnConnect=true:
     *   script hits DebugBreak() → Result DPE written → thread waits
     *   adapter connects with answer=true → receives current value immediately
     *   → StoppedEvent delivered to VS Code before any timeout
     *
     * Default: false (backwards-compatible — normal attach to a running manager)
     */
    answerOnConnect?: boolean;
}

export interface DebugCommand {
    /** Unique command ID (UUID) */
    id: string;
    /** Command string */
    cmd: string;
}

export class DatapointClient extends EventEmitter {
    /**
     * Hardcoded internal debug flag for development.
     * When true, DatapointClient writes diagnostic messages to process.stderr
     * (which ends up in the WinCC OA node manager log file).
     * Keep false in production to avoid polluting WinCC OA logs.
     */
    static readonly INTERNAL_DEBUG = false;

    private config: DatapointConfig;
    private connected = false;
    private debugDp = '';
    private api: IWinccoaManager | null = null;
    private connection: IWinccoaConnection | null = null;
    private resultSubscriptionId = -1;
    private pendingCommands = new Map<
        string,
        {
            cmd: string;
            resolve: (value: string[]) => void;
            reject: (err: Error) => void;
            timeout: NodeJS.Timeout;
        }
    >();

    /**
     * WinCC OA datapoint type for CTRL debug datapoints.
     * All `_CtrlDebug_CTRL_N` / `_CtrlDebug_UI_N` / … DPs share this DPT.
     * The DPT defines two elements: `.Command` (Text) and `.Result` (dyn_string).
     */
    private static readonly DEBUG_DP_TYPE = '_CtrlDebug';

    /**
     * Execution commands that may legitimately return a stop notification
     * ("line: N" format) as their response.  Context-selection commands
     * like "script N" or "thread N" can also return stop-format data, but
     * we must NOT re-emit those as 'message' events — doing so sends a
     * spurious StoppedEvent to VS Code for every stackTrace/variables
     * request, which is the root cause of the "3 Continue presses" bug.
     *
     * WinCC OA 3.21 correct command names (from CTRLdebugger.ctl):
     *   cont / c  — continue execution
     *   step in   — step into function
     *   step out  — step out of function
     *   step over — step over (next line)
     *   b / break — pause / break execution
     */
    private static readonly EXEC_CMD_RE = /^(cont|c|step in|step out|step over|b|break)/;

    /**
     * Step commands that use a two-phase response protocol:
     *   Phase 1: WinCC OA returns [id, "OK"] to acknowledge receipt.
     *   Phase 2: WinCC OA returns [id, "line: N", ...] with the new stop position.
     *
     * Both phases carry the SAME command ID.  We must NOT resolve/delete the
     * pending entry on phase 1 — keep it alive until phase 2 ("line:") arrives.
     */
    private static readonly STEP_CMD_RE = /^(step in|step out|step over)/;

    /**
     * @param config - Connection configuration
     * @param manager - Optional WinccoaManager instance for dependency injection (testing).
     *                  In production this is loaded from winccoa-manager at connect() time.
     * @param connection - Optional connection handle (testing only, not used in production).
     */
    constructor(
        config: DatapointConfig,
        manager?: IWinccoaManager,
        connection?: IWinccoaConnection,
    ) {
        super();
        this.config = config;
        this.debugDp = this.getDebugDpName();
        if (manager) {
            this.api = manager;
        }
        if (connection) {
            this.connection = connection;
        }
    }

    /**
     * Connect to WinCC OA.
     *
     * In production: the process must already have been started by pmon with
     * proper -proj/-host/-port/-num args in process.argv. The winccoa-manager
     * package bootstraps the connection from those args automatically.
     *
     * In tests: a mock IWinccoaManager is injected via the constructor.
     */
    public async connect(): Promise<void> {
        try {
            if (!this.api) {
                // If explicit connection args are provided (integration test scenario),
                // inject them into process.argv BEFORE the winccoa-manager singleton
                // initialises its native ConnectionBinding. The singleton reads
                // process.argv exactly once, so this must happen before the first
                // `new WinccoaManager()` call in the current process.
                if (this.config.connectionArgs && this.config.connectionArgs.length > 0) {
                    process.argv = ['node', 'winccoa-debug-adapter', ...this.config.connectionArgs];
                }

                // Load the official Siemens winccoa-manager package.
                // Requires WinCC OA args to be present in process.argv (see above).
                const managerPath = this.resolveManagerPath();
                const mod = (await import(managerPath)) as
                    | { WinccoaManager: new () => IWinccoaManager }
                    | { default: { WinccoaManager: new () => IWinccoaManager } };
                const { WinccoaManager } = 'default' in mod ? mod.default : mod;
                this.api = new WinccoaManager();

                // Start the ConnectionBinding dispatch loop.
                // When pmon launches the process, bootstrap.js calls
                // ConnectionBinding.instance.start() automatically.
                // When the process is spawned directly (e.g., VS Code spawning
                // cli.js --stdio), bootstrap.js is NOT used, so we must call
                // start() ourselves to:
                //   1) register this process as a WinCC OA manager (managerStart)
                //   2) begin the setImmediate-based dispatch loop so dpConnect
                //      callbacks are delivered.
                // start() is idempotent — a second call returns false and is a no-op.
                const connBindingPath = path.join(
                    path.dirname(managerPath),
                    'lib',
                    'connection-binding.js',
                );
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { ConnectionBinding } = require(connBindingPath) as {
                    ConnectionBinding: { instance: { start(): boolean } };
                };
                ConnectionBinding.instance.start();

                // Authenticate so we are allowed to write to system DPs like
                // _CtrlDebug_CTRL_5.Command (which requires user permission 4).
                // User ID 1 = the built-in WinCC OA root/admin user.
                // setUserId without password only works when this OS process
                // is running as Linux root OR when the project has no server-side
                // manager authentication enabled (the common dev-project default).
                try {
                    (this.api as any).setUserId(1);
                } catch (e) {
                    if (DatapointClient.INTERNAL_DEBUG) {
                        process.stderr.write(
                            `[DatapointClient] setUserId(1) failed: ${(e as Error).message} — continuing anyway\n`,
                        );
                    }
                }
            }

            // Ensure the debug DP exists — auto-create if missing.
            // WinCC OA pre-creates _CtrlDebug_CTRL_1 through _9 during project
            // setup, but DPs for manager numbers ≥10 must be created on the fly.
            await this.ensureDebugDpExists();

            // Subscribe to the Result DPE to receive debugger responses.
            // Official API: dpConnect(callback, dpeNames) — callback comes FIRST.
            // DPE structure is flat: [<system>:]_CtrlDebug_CTRL_1.Result
            // System prefix is optional — set config.system only when required.
            // Official WinccoaManager dpConnect callback signature:
            //   (names: string[], values: unknown[], type: WinccoaConnectUpdateType, error?)
            // names[i]  = DPE name (e.g. "System1:_CtrlDebug_CTRL_5.Result")
            // values[i] = actual DPE value (dyn_string arriving as JS string[])
            const resultDpe = this.buildDpe('Result');

            // The CTRL manager may not have created its _CtrlDebug_ DPs yet when
            // we connect (pmon auto-starts managers asynchronously after the DM is
            // ready).  dpConnect returns -1 if the DPE does not exist — poll with
            // a 500 ms interval for up to 30 s before giving up.
            const dpConnectCallback = (_names: any[], values: any[]) => {
                this.handleResponse(values[0]);
            };
            const connectDeadlineMs = Date.now() + 30_000;
            let dpConnectAttempts = 0;
            while (this.resultSubscriptionId < 0 && Date.now() < connectDeadlineMs) {
                dpConnectAttempts++;
                this.resultSubscriptionId = this.api.dpConnect(
                    dpConnectCallback,
                    resultDpe,
                    // answer=true fires callback immediately with current DP value on connect.
                    // Required for stopOnEntry / DebugBreak(): the script may have already
                    // stopped before the adapter connected, so we need the stale value.
                    // Default false for normal attach (don't replay old responses).
                    this.config.answerOnConnect ?? false,
                );
                if (this.resultSubscriptionId < 0) {
                    if (DatapointClient.INTERNAL_DEBUG) {
                        process.stderr.write(
                            `[DatapointClient] dpConnect attempt ${dpConnectAttempts} failed for "${resultDpe}" — retrying in 500 ms…\n`,
                        );
                    }
                    await new Promise<void>((r) => setTimeout(r, 500));
                }
            }

            // dpConnect returns -1 when the DPE does not exist or the subscription
            // failed.  After exhausting retries, surface a clear error so the test
            // can skip gracefully rather than hanging forever.
            if (this.resultSubscriptionId < 0) {
                throw new Error(
                    `dpConnect failed for "${resultDpe}" after ${dpConnectAttempts} attempt(s). ` +
                        `Ensure the CTRL manager is running and debug datapoints are initialised.`,
                );
            }

            this.connected = true;
            this.emit('connected');
        } catch (err) {
            this.emit('error', err);
            throw err;
        }
    }

    /**
     * Disconnect from WinCC OA
     */
    public async disconnect(): Promise<void> {
        // Cancel all pending commands
        for (const pending of this.pendingCommands.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Connection closed'));
        }
        this.pendingCommands.clear();

        // Unsubscribe from Result DPE
        if (this.api && this.resultSubscriptionId >= 0) {
            this.api.dpDisconnect(this.resultSubscriptionId);
            this.resultSubscriptionId = -1;
        }
        this.api = null;
        this.connection = null;

        this.connected = false;
        this.emit('disconnected');
    }

    /**
     * Send command to WinCC OA debugger
     */
    public async sendCommand(cmd: string, timeout = 5000): Promise<string[]> {
        if (!this.connected || !this.api) {
            throw new Error('Not connected to WinCC OA');
        }

        // Generate unique command ID
        const id = this.generateCommandId();

        // Create command object
        const command: DebugCommand = { id, cmd };

        // Create promise for response
        const responsePromise = new Promise<string[]>((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                this.pendingCommands.delete(id);
                reject(new Error(`Command timeout after ${timeout}ms: ${cmd}`));
            }, timeout);

            this.pendingCommands.set(id, { cmd, resolve, reject, timeout: timeoutHandle });
        });

        try {
            // Send command via dpSetWait to Command DPE.
            // dpSetWait (vs dpSet) confirms the write was received by the Data Manager —
            // avoids silent drops that occur when dpSet is called fire-and-forget before
            // the WinCC OA connection has fully processed the previous operation.
            // Official API: dpSetWait(dpeNames, values) → Promise<void>
            const commandDpe = this.buildDpe('Command');
            const payload = JSON.stringify(command);
            await this.api.dpSetWait(commandDpe, payload);

            // Wait for response
            const result = await responsePromise;
            return result;
        } catch (err) {
            this.pendingCommands.delete(id);
            throw err;
        }
    }

    /**
     * Handle response from WinCC OA
     */
    private handleResponse(value: any): void {
        try {
            // Response should be a dyn_string: [id, ...result].
            // WinCC OA fires dpConnect once immediately with the current DP value,
            // which is null/undefined/empty on first subscribe — silently ignore.
            if (value === null || value === undefined) {
                return;
            }
            if (!Array.isArray(value) || value.length === 0) {
                return;
            }
            const [id, ...result] = value as string[];

            // Find pending command
            const pending = this.pendingCommands.get(id);
            if (pending) {
                const isStepCmd = DatapointClient.STEP_CMD_RE.test(pending.cmd);
                const isStopData = result[0]?.startsWith('line: ');

                // Step commands (step in/out/over) use a TWO-PHASE response protocol:
                //   Phase 1: [id, "OK"]          — acknowledgment, keep pending alive
                //   Phase 2: [id, "line: N", ...] — actual stop position, resolve
                // Do NOT resolve/delete the pending on phase 1; wait for phase 2.
                if (isStepCmd && !isStopData && result[0] === 'OK') {
                    return;
                }

                clearTimeout(pending.timeout);
                this.pendingCommands.delete(id);
                // WinCC OA 3.21 prepends the command's ID to the stop-data response
                // for execution commands (step in/out/over, cont, b).  Re-emit as
                // 'message' so WinCCDebugSession handles it as a StoppedEvent.
                // Context-selection commands like "script N" / "thread N" can also
                // return stop-format data but must NOT trigger StoppedEvent —
                // that would cause spurious extra stops on every stackTrace request.
                if (DatapointClient.EXEC_CMD_RE.test(pending.cmd) && isStopData) {
                    this.emit('message', result);
                }
                pending.resolve(result);
            } else {
                // Unsolicited event from the WinCC OA CTRL engine (e.g. breakpoint hit).
                // The CTRL engine does NOT prepend a command uuid — the first element IS
                // the first data field (e.g. "line: 5").  Emit the full array so event
                // handlers receive the complete notification including that first field.
                this.emit('message', value as string[]);
            }
        } catch (err) {
            this.emit('error', err);
        }
    }

    /**
     * Generate unique command ID
     */
    private generateCommandId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Get debug datapoint name
     */
    private getDebugDpName(): string {
        const managerPrefix = this.getManagerPrefix();
        return `_CtrlDebug_${managerPrefix}_${this.config.managerNumber}`;
    }

    /**
     * Get manager type prefix
     */
    private getManagerPrefix(): string {
        switch (this.config.managerType) {
            case 'CTRL':
                return 'CTRL';
            case 'UI':
                return 'UI';
            case 'EVENT':
                return 'EVENT';
            case 'ASCII':
                return 'ASCII';
            case 'DEVICE':
                return 'DEVICE';
            case 'API':
                return 'API';
            case 'DRIVER':
                return 'DRIVER';
            default:
                return 'CTRL';
        }
    }

    /**
     * Check if connected
     */
    public isConnected(): boolean {
        return this.connected;
    }

    /**
     * Get debug datapoint name (public accessor)
     */
    public getDebugDp(): string {
        return this.debugDp;
    }

    /**
     * Build a fully-qualified DPE name, prepending the system prefix when configured.
     * Examples:
     *   system='System1' → 'System1:_CtrlDebug_CTRL_1.Result'
     *   system='system1' → 'system1:_CtrlDebug_CTRL_1.Result'
     *   system=undefined → '_CtrlDebug_CTRL_1.Result'
     */
    private buildDpe(element: 'Result' | 'Command'): string {
        const base = `${this.debugDp}.${element}`;
        return this.config.system ? `${this.config.system}:${base}` : base;
    }

    /**
     * Ensure the debug datapoint exists, creating it if necessary.
     *
     * WinCC OA only pre-creates `_CtrlDebug_CTRL_1` through `_9` during
     * project initialisation.  When the adapter targets a manager number
     * ≥10 (or any other number whose DP is missing), this method creates
     * the DP with the standard `_CtrlDebug` DPT so dpConnect can succeed.
     */
    private async ensureDebugDpExists(): Promise<void> {
        if (!this.api) return;

        if (this.api.dpExists(this.debugDp)) return;

        if (DatapointClient.INTERNAL_DEBUG) {
            process.stderr.write(
                `[DatapointClient] Debug DP "${this.debugDp}" does not exist — creating…\n`,
            );
        }

        await this.api.dpCreate(this.debugDp, DatapointClient.DEBUG_DP_TYPE);

        if (DatapointClient.INTERNAL_DEBUG) {
            process.stderr.write(
                `[DatapointClient] Debug DP "${this.debugDp}" created successfully.\n`,
            );
        }
    }

    /**
     * Resolve path to the official winccoa-manager package bundled with WinCC OA.
     * Located at <install>/javascript/winccoa-manager/index.js
     */
    private resolveManagerPath(): string {
        // Use npm-winccoa-core for cross-platform version discovery
        const versions: string[] = getAvailableWinCCOAVersions();
        if (versions.length === 0) {
            throw new Error(
                'No WinCC OA installation found. ' +
                    'Ensure WinCC OA is installed or inject a mock manager for testing.',
            );
        }

        const version = versions.includes('3.21') ? '3.21' : versions[versions.length - 1];
        const installPath: string | null | undefined = getWinCCOAInstallationPathByVersion(version);
        if (!installPath) {
            throw new Error(`WinCC OA installation path not found for version ${version}`);
        }

        return path.join(installPath, 'javascript', 'winccoa-manager', 'index.js');
    }
}
