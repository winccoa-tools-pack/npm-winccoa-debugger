/**
 * DatapointClient
 *
 * Client for communicating with WinCC OA via the Datapoint API.
 *
 * Responsibilities:
 * - Connect to WinCC OA as a manager via winccoaconnection.node
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
 * The Node.js process connects to WinCC OA as a manager via the native
 * winccoaconnection.node addon (shipped with WinCC OA). This is NOT a raw
 * TCP socket — WinCC OA handles the protocol internally.
 */

import { EventEmitter } from 'events';
import path from 'path';
import { getWinCCOAInstallationPathByVersion, getAvailableWinCCOAVersions } from '@winccoa-tools-pack/npm-winccoa-core';

/** Minimal interface for the WinccoaManagerApi from winccoaconnection.node */
export interface IWinccoaApi {
  dpConnect(dpName: string, callback: (value: any) => void): void;
  dpSet(dpName: string, value: any): void;
  dpGet(dpName: string): Promise<any>;
}

/** Minimal interface for WinccoaManagerConnection */
export interface IWinccoaConnection {
  managerStart(args: string[], api: IWinccoaApi): Promise<void>;
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
  private api: IWinccoaApi | null = null;
  private connection: IWinccoaConnection | null = null;
  private pendingCommands = new Map<string, { resolve: (value: string[]) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }>();

  /**
   * @param config - Connection configuration
   * @param api - Optional WinccoaManagerApi instance for dependency injection (testing)
   * @param connection - Optional WinccoaManagerConnection for dependency injection (testing)
   */
  constructor(config: DatapointConfig, api?: IWinccoaApi, connection?: IWinccoaConnection) {
    super();
    this.config = config;
    this.debugDp = this.getDebugDpName();
    if (api) {
      this.api = api;
    }
    if (connection) {
      this.connection = connection;
    }
  }

  /**
   * Connect to WinCC OA.
   * If no api was injected, loads winccoaconnection.node from the WinCC OA installation.
   */
  public async connect(): Promise<void> {
    try {
      if (!this.api) {
        // Load real WinCC OA native addon
        const addonPath = this.resolveAddonPath();
        const { WinccoaManagerApi, WinccoaManagerConnection } = require(addonPath);
        this.api = new WinccoaManagerApi() as IWinccoaApi;
        this.connection = new WinccoaManagerConnection() as IWinccoaConnection;
      }

      // Register as a WinCC OA manager (no-op when connection is mocked)
      if (this.connection) {
        await this.connection.managerStart(
          [
            `-proj`, this.config.system,
            `-host`, this.config.host,
            `-port`, String(this.config.port),
            `-num`, `90`,    // high manager number to avoid conflicts
            `-m`, `apiMgr`,  // API manager type
          ],
          this.api,
        );
      }

      // Subscribe to the Result DPE to receive debugger responses
      const resultDpe = `${this.debugDp}.Result`;
      this.api.dpConnect(resultDpe, (value: any) => {
        this.handleResponse(value);
      });

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

    // Disconnect from WinCC OA
    if (this.connection) {
      this.connection.prepareExit();
      this.connection = null;
    }
    this.api = null;

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
      // Send command via dpSet to Command DPE
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
      case 'CTRL': return 'CTRL';
      case 'UI': return 'UI';
      case 'EVENT': return 'EVENT';
      case 'ASCII': return 'ASCII';
      case 'DEVICE': return 'DEVICE';
      case 'API': return 'API';
      case 'DRIVER': return 'DRIVER';
      default: return 'CTRL';
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
   * Resolve path to winccoaconnection.node from the installed WinCC OA version.
   * Uses npm-winccoa-core to find the installation path.
   */
  private resolveAddonPath(): string {
    const versions = getAvailableWinCCOAVersions();
    if (versions.length === 0) {
      throw new Error('No WinCC OA installation found. Install WinCC OA or inject a mock api for testing.');
    }

    // Prefer exact version match, fall back to latest
    const version = versions.includes('3.21') ? '3.21' : versions[versions.length - 1];
    const installPath = getWinCCOAInstallationPathByVersion(version);

    if (!installPath) {
      throw new Error(`WinCC OA installation path not found for version ${version}`);
    }

    return path.join(installPath, 'bin', 'winccoaconnection.node');
  }
}
