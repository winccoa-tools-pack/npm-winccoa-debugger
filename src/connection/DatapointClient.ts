/**
 * DatapointClient
 * 
 * Client for communicating with WinCC OA via the Datapoint API.
 * 
 * Responsibilities:
 * - Connect to WinCC OA Data Manager
 * - Send commands to _CtrlDebug_<Manager>_<Num> datapoint
 * - Receive responses via HotLink callback
 * - Handle connection lifecycle (connect, disconnect, reconnect)
 * - Emit events for incoming messages
 * 
 * Protocol:
 * - Command DPE: _CtrlDebug_CTRL_1.Command (Text)
 * - Result DPE: _CtrlDebug_CTRL_1.Result (dyn_string)
 * - Commands are JSON encoded: { id: "uuid", cmd: "command string" }
 * - Responses are JSON arrays matching command ID
 */

import { EventEmitter } from 'events';
import { Manager } from '@winccoa-tools-pack/npm-winccoa-core';

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
  private manager: Manager | null = null;
  private pendingCommands = new Map<string, { resolve: (value: string[]) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }>();

  constructor(config: DatapointConfig) {
    super();
    this.config = config;
    this.debugDp = this.getDebugDpName();
  }

  /**
   * Connect to WinCC OA
   */
  public async connect(): Promise<void> {
    try {
      // Create Manager instance from npm-winccoa-core
      this.manager = new Manager({
        host: this.config.host,
        port: this.config.port,
        managerOptions: {
          manNum: 1,
          manType: 'ctrl',
        },
      });

      // Setup error handling
      this.manager.on('error', (err: Error) => {
        this.emit('error', err);
      });

      this.manager.on('disconnected', () => {
        this.connected = false;
        this.emit('disconnected');
      });

      // Connect to WinCC OA
      await this.manager.connect();
      this.connected = true;

      // Setup datapoint connection to receive responses
      const resultDpe = `${this.debugDp}.Result`;
      await this.manager.dpConnect(resultDpe, (value: any) => {
        this.handleResponse(value);
      });

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
    for (const [id, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingCommands.clear();

    // Disconnect manager
    if (this.manager) {
      await this.manager.disconnect();
      this.manager = null;
    }

    this.connected = false;
    this.emit('disconnected');
  }

  /**
   * Send command to WinCC OA debugger
   */
  public async sendCommand(cmd: string, timeout = 5000): Promise<string[]> {
    if (!this.connected || !this.manager) {
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
      await this.manager.dpSet(commandDpe, JSON.stringify(command));

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
}
