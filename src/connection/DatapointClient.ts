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
 * - Command DPE: _CtrlDebug_CTRL_1.Command (Text)
 * - Result DPE:  _CtrlDebug_CTRL_1.Result (dyn_string)
 * - Commands are JSON:  { id: "timestamp-random", cmd: "break scripts/test.ctl 10" }
 * - Responses are JSON array: ["timestamp-random", "OK", ...lines]
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
import fs from 'fs';
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
    /** Subscribe to DPE value changes. Callback receives (values, dpeNames). */
    dpConnect(
        callback: (values: any[], dpeNames: string[]) => void,
        dpeNames: string | string[],
        answer?: boolean,
    ): number;
    /** Disconnect a dpConnect subscription by its returned id. */
    dpDisconnect(id: number): void;
    /** Write value(s) to one or more DPEs. Fire-and-forget. */
    dpSet(dpeNames: string | string[], values: any | any[]): void;
    /** Write and wait until the value is confirmed by the Data Manager. */
    dpSetWait(dpeNames: string | string[], values: any | any[]): Promise<void>;
}

/** @internal — kept for backwards compat with existing tests that check IWinccoaApi */
export type IWinccoaApi = IWinccoaManager;
/** @internal */
export interface IWinccoaConnection {
    managerStart(args: string[], api: IWinccoaManager): Promise<void>;
    prepareExit(): void;
}

export interface DatapointConfig {
    /** WinCC OA system name */
    system: string;
    /** Host address */
    host: string;
    /** Port number */
    port: number;
    /** Manager type */
    managerType: 'CTRL' | 'UI' | 'EVENT' | 'ASCII' | 'DEVICE' | 'API' | 'DRIVER';
    /** Manager number */
    managerNumber: number;
}

export interface DebugCommand {
    /** Unique command ID (UUID) */
    id: string;
    /** Command string */
    cmd: string;
}

export class DatapointClient extends EventEmitter {
    private config: DatapointConfig;
    private connected = false;
    private debugDp = '';
    private api: IWinccoaManager | null = null;
    private connection: IWinccoaConnection | null = null;
    private resultSubscriptionId = -1;
    private pendingCommands = new Map<
        string,
        {
            resolve: (value: string[]) => void;
            reject: (err: Error) => void;
            timeout: NodeJS.Timeout;
        }
    >();

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
                // Load the official Siemens winccoa-manager package.
                // Requires the process to have been started by WinCC OA pmon.
                const managerPath = this.resolveManagerPath();
                const mod = (await import(managerPath)) as
                    | { WinccoaManager: new () => IWinccoaManager }
                    | { default: { WinccoaManager: new () => IWinccoaManager } };
                const { WinccoaManager } = 'default' in mod ? mod.default : mod;
                this.api = new WinccoaManager();
            }

            // Subscribe to the Result DPE to receive debugger responses.
            // Official API: dpConnect(callback, dpeNames) — callback comes FIRST.
            const resultDpe = `${this.debugDp}.Result`;
            this.resultSubscriptionId = this.api.dpConnect((values: any[]) => {
                this.handleResponse(values[0]);
            }, resultDpe);

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

            this.pendingCommands.set(id, { resolve, reject, timeout: timeoutHandle });
        });

        try {
            // Send command via dpSet to Command DPE.
            // Official API: dpSet(dpeNames, values)
            const commandDpe = `${this.debugDp}.Command`;
            this.api.dpSet(commandDpe, JSON.stringify(command));

            // Wait for response
            return await responsePromise;
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
            // Response should be a dyn_string: [id, ...result]
            if (!Array.isArray(value) || value.length === 0) {
                this.emit('error', new Error('Invalid response format'));
                return;
            }

            const [id, ...result] = value as string[];

            // Find pending command
            const pending = this.pendingCommands.get(id);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingCommands.delete(id);
                pending.resolve(result);
            } else {
                // Unsolicited message
                this.emit('message', result);
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
     * Resolve path to the official winccoa-manager package bundled with WinCC OA.
     * Located at <install>/javascript/winccoa-manager/index.js
     */
    private resolveManagerPath(): string {
        // Try the well-known default path first
        const defaultPath = '/opt/WinCC_OA/3.21/javascript/winccoa-manager';
        if (fs.existsSync(defaultPath)) {
            return defaultPath;
        }

        // Fall back to npm-winccoa-core for version discovery
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

        return path.join(installPath, 'javascript', 'winccoa-manager');
    }
}
