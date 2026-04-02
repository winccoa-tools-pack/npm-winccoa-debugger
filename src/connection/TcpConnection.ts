/**
 * TcpConnection
 *
 * Low-level TCP connection to WinCC OA Data Manager.
 *
 * Responsibilities:
 * - Establish TCP connection to WinCC OA
 * - Send and receive binary protocol messages
 * - Handle connection state and errors
 * - Implement WinCC OA binary protocol
 *
 * Note: This is a low-level component. Most users should use DatapointClient instead.
 */

import { EventEmitter } from 'events';
import * as net from 'net';

export interface TcpConnectionConfig {
    host: string;
    port: number;
    timeout?: number;
}

export class TcpConnection extends EventEmitter {
    private config: TcpConnectionConfig;
    private socket: net.Socket | null = null;
    private connected = false;

    constructor(config: TcpConnectionConfig) {
        super();
        this.config = config;
    }

    /**
     * Connect to WinCC OA
     */
    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket = new net.Socket();

            this.socket.on('connect', () => {
                this.connected = true;
                this.emit('connected');
                resolve();
            });

            this.socket.on('data', (data: Buffer) => {
                this.handleData(data);
            });

            this.socket.on('error', (error: Error) => {
                this.emit('error', error);
                reject(error);
            });

            this.socket.on('close', () => {
                this.connected = false;
                this.emit('disconnected');
            });

            this.socket.connect(this.config.port, this.config.host);

            if (this.config.timeout) {
                this.socket.setTimeout(this.config.timeout);
            }
        });
    }

    /**
     * Disconnect from WinCC OA
     */
    public disconnect(): void {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
    }

    /**
     * Send data to WinCC OA
     */
    public send(data: Buffer): void {
        if (!this.socket || !this.connected) {
            throw new Error('Not connected');
        }
        this.socket.write(data);
    }

    /**
     * Handle incoming data
     */
    private handleData(data: Buffer): void {
        // TODO: Parse WinCC OA protocol messages
        this.emit('data', data);
    }

    /**
     * Check if connected
     */
    public isConnected(): boolean {
        return this.connected;
    }
}
