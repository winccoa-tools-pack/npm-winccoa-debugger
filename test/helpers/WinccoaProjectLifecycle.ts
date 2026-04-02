/**
 * WinccoaProjectLifecycle
 *
 * Manages the lifetime of a WinCC OA project for integration testing.
 *
 * Responsibilities:
 * - Substitute <WinCC_OA_PATH> / <WinCC_OA_VERSION> placeholders in project config
 * - Start WinCC OA pmon (and wait for Data Manager to accept connections)
 * - Stop pmon after tests
 * - Build the DatapointConfig.connectionArgs for the test adapter
 *
 * Usage:
 * ```typescript
 * const lc = new WinccoaProjectLifecycle('/abs/path/to/debugger-poc');
 * if (!lc.isWinccoaAvailable()) { skip(); return; }
 * await lc.start();
 * try {
 *   const config = lc.getDatapointConfig('CTRL', 1);
 *   const client = new DatapointClient(config);
 *   await client.connect();
 *   // ... tests ...
 * } finally {
 *   await lc.stop();
 * }
 * ```
 *
 * Environment variables that control behaviour:
 *   WINCCOA_TEST_PROJ   – project name as registered with pmon  (default: derived from projPath basename)
 *   WINCCOA_TEST_HOST   – WinCC OA host  (default: localhost)
 *   WINCCOA_TEST_PORT   – WinCC OA port  (default: 4999)
 *   WINCCOA_TEST_NUM    – manager number to use for the test adapter  (default: 99)
 *   WINCCOA_SKIP        – if set to '1', all lifecycle methods are no-ops and isWinccoaAvailable() → false
 */

import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn, SpawnOptions } from 'child_process';
import {
    getAvailableWinCCOAVersions,
    getWinCCOAInstallationPathByVersion,
} from '@winccoa-tools-pack/npm-winccoa-core';
import type { DatapointConfig } from '../../src/connection/DatapointClient';

// ─── constants ───────────────────────────────────────────────────────────────

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 4999;
const DEFAULT_MANAGER_NUM = 99;

/** How many ms to wait between port-availability polls */
const POLL_INTERVAL_MS = 500;
/** Total time to wait for WinCC OA Data Manager to be reachable */
const STARTUP_TIMEOUT_MS = 30_000;
/** Total time to wait for project to stop */
const STOP_TIMEOUT_MS = 15_000;

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Returns true if a TCP connection to host:port succeeds within timeoutMs */
function isTcpReachable(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const cleanup = (result: boolean) => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => cleanup(true));
        socket.once('error', () => cleanup(false));
        socket.once('timeout', () => cleanup(false));
        socket.connect(port, host);
    });
}

/** Polls isTcpReachable until it returns true or totalMs elapses */
async function waitForPort(
    host: string,
    port: number,
    totalMs: number,
    pollMs = POLL_INTERVAL_MS,
): Promise<boolean> {
    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
        if (await isTcpReachable(host, port)) return true;
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
}

/** Polls until the port is NO LONGER reachable */
async function waitForPortClosed(
    host: string,
    port: number,
    totalMs: number,
    pollMs = POLL_INTERVAL_MS,
): Promise<void> {
    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
        if (!(await isTcpReachable(host, port))) return;
        await new Promise((r) => setTimeout(r, pollMs));
    }
}

// ─── main class ──────────────────────────────────────────────────────────────

export class WinccoaProjectLifecycle {
    private readonly projPath: string;
    private readonly host: string;
    private readonly port: number;
    private readonly managerNum: number;
    private readonly projName: string;
    private winccoaInstallPath: string | null = null;
    private winccoaVersion: string | null = null;

    constructor(projPath: string) {
        this.projPath = path.resolve(projPath);
        this.host = process.env['WINCCOA_TEST_HOST'] ?? DEFAULT_HOST;
        this.port = Number(process.env['WINCCOA_TEST_PORT'] ?? DEFAULT_PORT);
        this.managerNum = Number(process.env['WINCCOA_TEST_NUM'] ?? DEFAULT_MANAGER_NUM);
        // WINCCOA_TEST_PROJ wins, then PVSS_II_PROJ (already registered project),
        // then fall back to the fixture directory name.
        this.projName =
            process.env['WINCCOA_TEST_PROJ'] ??
            process.env['PVSS_II_PROJ'] ??
            path.basename(this.projPath);
    }

    // ─── public API ────────────────────────────────────────────────────────────

    /**
     * Returns false when:
     * - WINCCOA_SKIP=1 is set, or
     * - No WinCC OA installation is found on this machine, or
     * - Neither WINCCOA_TEST_PROJ nor PVSS_II_PROJ is set.
     *
     * The last guard prevents accidentally calling `new WinccoaManager()` against
     * an unrelated WinCC OA project.  The WinCC OA native addon calls
     * `process.exit(1)` when it cannot resolve the project name — which would
     * kill the entire test process.  Require an explicit project name to be set
     * in the environment before attempting any real connection.
     */
    public isWinccoaAvailable(): boolean {
        if (process.env['WINCCOA_SKIP'] === '1') return false;
        // Require an explicit project name to avoid calling the native addon with
        // a wrong project name and crashing with exit(1).
        if (!process.env['WINCCOA_TEST_PROJ'] && !process.env['PVSS_II_PROJ']) return false;
        return this.resolveInstallation() !== null;
    }

    /**
     * Prepare config files, start pmon and wait for the Data Manager to be ready.
     * Idempotent: if WinCC OA is already reachable on the configured port, startup
     * is skipped (another process may already be running the project).
     */
    public async start(): Promise<void> {
        this.requireAvailable();
        this.substituteConfigPlaceholders();

        if (await isTcpReachable(this.host, this.port)) {
            console.log(
                `[WinccoaProjectLifecycle] WinCC OA already reachable at ${this.host}:${this.port} — skipping start`,
            );
            return;
        }

        console.log(`[WinccoaProjectLifecycle] Starting WinCC OA project "${this.projName}"…`);
        await this.spawnPmon();

        const ready = await waitForPort(this.host, this.port, STARTUP_TIMEOUT_MS);
        if (!ready) {
            throw new Error(
                `[WinccoaProjectLifecycle] WinCC OA did not become reachable on ` +
                    `${this.host}:${this.port} within ${STARTUP_TIMEOUT_MS / 1000}s`,
            );
        }
        console.log(`[WinccoaProjectLifecycle] WinCC OA ready at ${this.host}:${this.port}`);
    }

    /**
     * Stop pmon and wait for the port to close.
     * Safe to call even when start() was skipped.
     */
    public async stop(): Promise<void> {
        this.requireAvailable();

        if (!(await isTcpReachable(this.host, this.port))) {
            console.log('[WinccoaProjectLifecycle] WinCC OA not running — skipping stop');
            return;
        }

        console.log(`[WinccoaProjectLifecycle] Stopping WinCC OA project "${this.projName}"…`);
        await this.spawnPmonStop();
        await waitForPortClosed(this.host, this.port, STOP_TIMEOUT_MS);
        console.log('[WinccoaProjectLifecycle] WinCC OA stopped');
    }

    /**
     * Returns false if WinCC OA is not currently reachable on the configured port.
     * Useful for test-level skip guards without starting the project.
     */
    public async isRunning(): Promise<boolean> {
        return isTcpReachable(this.host, this.port);
    }

    /**
     * Returns a fully populated DatapointConfig for the given manager type/number.
     * Includes connectionArgs so DatapointClient can bootstrap the winccoa-manager
     * singleton even when the test process was not started by pmon.
     *
     * @param debugManagerType - The type of the CTRL manager whose debugger to attach to
     * @param debugManagerNumber - The number of that CTRL manager (usually 1)
     */
    public getDatapointConfig(
        debugManagerType: DatapointConfig['managerType'],
        debugManagerNumber: number,
    ): DatapointConfig {
        return {
            system: this.projName,
            host: this.host,
            port: this.port,
            managerType: debugManagerType,
            managerNumber: debugManagerNumber,
            connectionArgs: this.getConnectionArgs(),
        };
    }

    /**
     * The WinCC OA connection args that would normally be injected by pmon.
     * Pass these as DatapointConfig.connectionArgs so DatapointClient can
     * initialise the native adapter even from a plain `node` process.
     */
    public getConnectionArgs(): string[] {
        return [
            '-proj',
            this.projName,
            '-host',
            this.host,
            '-port',
            String(this.port),
            '-num',
            String(this.managerNum),
            '-m',
            'jscript',
        ];
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    private requireAvailable(): void {
        if (!this.isWinccoaAvailable()) {
            throw new Error(
                '[WinccoaProjectLifecycle] WinCC OA is not available on this machine. ' +
                    'Set WINCCOA_SKIP=1 to explicitly opt-out or install WinCC OA.',
            );
        }
    }

    /**
     * Replaces <WinCC_OA_PATH> and <WinCC_OA_VERSION> placeholders in every
     * text file under config/ (in-place).
     */
    private substituteConfigPlaceholders(): void {
        const info = this.resolveInstallation();
        if (!info) return;

        const configDir = path.join(this.projPath, 'config');
        if (!fs.existsSync(configDir)) return;

        for (const file of fs.readdirSync(configDir)) {
            const filePath = path.join(configDir, file);
            if (!fs.statSync(filePath).isFile()) continue;
            let content = fs.readFileSync(filePath, 'utf-8');
            if (!content.includes('<WinCC_OA_PATH>') && !content.includes('<WinCC_OA_VERSION>')) {
                continue;
            }
            content = content
                .replace(/<WinCC_OA_PATH>/g, info.installPath)
                .replace(/<WinCC_OA_VERSION>/g, info.version);
            fs.writeFileSync(filePath, content, 'utf-8');
        }
    }

    private resolveInstallation(): { installPath: string; version: string } | null {
        if (this.winccoaInstallPath && this.winccoaVersion) {
            return { installPath: this.winccoaInstallPath, version: this.winccoaVersion };
        }
        try {
            const versions = getAvailableWinCCOAVersions();
            if (versions.length === 0) return null;
            const version = versions.includes('3.21') ? '3.21' : versions[versions.length - 1];
            const installPath = getWinCCOAInstallationPathByVersion(version);
            if (!installPath) return null;
            this.winccoaInstallPath = installPath;
            this.winccoaVersion = version;
            return { installPath, version };
        } catch {
            return null;
        }
    }

    private pmonBin(): string {
        const info = this.resolveInstallation();
        if (!info) throw new Error('WinCC OA not found');
        return path.join(info.installPath, 'bin', 'WCCILpmon');
    }

    private spawnDetached(cmd: string, args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const opts: SpawnOptions = { detached: true, stdio: 'ignore' };
            const child = spawn(cmd, args, opts);
            child.on('error', reject);
            // We only wait for spawn to succeed, not for the process to exit
            child.unref();
            resolve();
        });
    }

    private spawnAndWait(cmd: string, args: string[]): Promise<number> {
        return new Promise((resolve, reject) => {
            const child = spawn(cmd, args, { stdio: 'pipe' });
            child.on('error', reject);
            child.on('close', (code) => resolve(code ?? 0));
        });
    }

    private async spawnPmon(): Promise<void> {
        // WCCILpmon -proj <path> — starts pmon as a daemon when run without -stop/-status
        await this.spawnDetached(this.pmonBin(), ['-proj', this.projPath]);
    }

    private async spawnPmonStop(): Promise<void> {
        // WCCILpmon -proj <path> -stopWait — stops and waits
        await this.spawnAndWait(this.pmonBin(), ['-proj', this.projPath, '-stopWait']);
    }
}
