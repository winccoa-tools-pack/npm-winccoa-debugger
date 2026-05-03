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
import {
    PmonComponent,
    getAvailableWinCCOAVersions,
    getWinCCOAInstallationPathByVersion,
} from '@winccoa-tools-pack/npm-winccoa-core';
import type { DatapointConfig } from '../../src/connection/DatapointClient';

// ─── constants ───────────────────────────────────────────────────────────────

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 4999;
const DEFAULT_MANAGER_NUM = 99;

/** Shared SQLite seed directory — clean DB snapshot used before each project start */
const SEEDS_SQLITE_DIR = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../fixtures/seeds/sqlite',
);

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

/** Escapes special regex characters in a literal string */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    /** Set to true when start() registered the project (so stop() can unregister it) */
    private didRegisterProject = false;

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

        // Restore config placeholders synchronously on process exit so the fixture
        // stays as a committed template even when --test-force-exit kills the process
        // before async cleanup in test.after() fully completes.
        process.on('exit', () => this.restoreConfigPlaceholders());
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
        if (process.env['WINCCOA_EXTERNAL'] === '1') {
            // Lifecycle is managed externally by the test runner — always considered available
            return true;
        }
        if (process.env['WINCCOA_SKIP'] === '1') return false;
        // Require an explicit project name to avoid calling the native addon with
        // a wrong project name and crashing with exit(1).
        if (!process.env['WINCCOA_TEST_PROJ'] && !process.env['PVSS_II_PROJ']) return false;
        return this.resolveInstallation() !== null;
    }

    /**
     * Prepare config files, register + start pmon and wait for the Data Manager
     * to accept connections.
     * Idempotent: if WinCC OA is already reachable on the configured port, startup
     * is skipped (another process may already be running the project).
     */
    public async start(): Promise<void> {
        if (process.env['WINCCOA_EXTERNAL'] === '1') {
            // Lifecycle is owned by the test runner — nothing to do here.
            return;
        }
        this.requireAvailable();
        this.substituteConfigPlaceholders();

        if (await isTcpReachable(this.host, this.port)) {
            console.log(
                `[WinccoaProjectLifecycle] WinCC OA already reachable at ${this.host}:${this.port} — skipping start`,
            );
            return;
        }

        const info = this.resolveInstallation();
        if (!info) throw new Error('[WinccoaProjectLifecycle] WinCC OA installation not found');

        const pmon = new PmonComponent();
        pmon.setVersion(info.version);

        // Register the project in /etc/opt/pvss/pvssInst.conf so pmon can find it.
        // Skip registration (and the matching unregister-on-stop) if the project is
        // already present in pvssInst.conf — this keeps it visible in the VS Code
        // Project Admin extension after the test run finishes.
        const configFilePath = path.join(this.projPath, 'config', 'config');
        if (this.isProjectRegisteredInPvssConf()) {
            console.log(
                `[WinccoaProjectLifecycle] Project "${this.projName}" already registered in pvssInst.conf — skipping registration`,
            );
        } else {
            console.log(`[WinccoaProjectLifecycle] Registering project "${this.projName}" …`);
            await pmon.registerProject(configFilePath, info.version);
            this.didRegisterProject = true;
        }

        // Restore clean SQLite databases from seeds so every test run starts fresh.
        this.restoreDbFromSeed();

        // Start pmon detached — pmon auto-starts managers whose mode is 'always'.
        console.log(`[WinccoaProjectLifecycle] Starting WinCC OA project "${this.projName}"…`);
        await pmon.startProject(this.projName, false);

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
     * If this lifecycle instance registered the project (didRegisterProject=true),
     * the pvssInst.conf entry is always removed on stop so integration tests
     * leave a clean state.
     * If the project was already registered before start() was called, no
     * registration change is made.
     */
    public async stop(): Promise<void> {
        if (process.env['WINCCOA_EXTERNAL'] === '1') {
            // Lifecycle is owned by the test runner — nothing to do here.
            return;
        }
        this.requireAvailable();

        if (!(await isTcpReachable(this.host, this.port))) {
            console.log('[WinccoaProjectLifecycle] WinCC OA not running — skipping stop');
            return;
        }

        const info = this.resolveInstallation();
        if (!info) throw new Error('[WinccoaProjectLifecycle] WinCC OA installation not found');

        const pmon = new PmonComponent();
        pmon.setVersion(info.version);

        console.log(`[WinccoaProjectLifecycle] Stopping WinCC OA project "${this.projName}"…`);
        await pmon.stopProjectAndPmon(this.projName, STOP_TIMEOUT_MS);
        await waitForPortClosed(this.host, this.port, STOP_TIMEOUT_MS);
        console.log('[WinccoaProjectLifecycle] WinCC OA stopped');

        if (this.didRegisterProject) {
            console.log(`[WinccoaProjectLifecycle] Unregistering project "${this.projName}"…`);
            await pmon.unregisterProject(this.projName);
            this.didRegisterProject = false;
        }

        this.restoreConfigPlaceholders();
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
            system: process.env['WINCCOA_TEST_SYSTEM'] ?? 'System1',
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

    /**
     * Starts a specific CTRL manager identified by its `-num N` flag.
     *
     * Scans the manager list via `pmon MGRLIST:LIST` and finds the entry whose
     * `startOptions` contains `-num <managerNum>`.  Then starts it by index via
     * `pmon SINGLE_MGR:START <index>`.
     *
     * Use this in tests to start a `manual`-mode manager after pmon is already
     * running (e.g. the `-dbg CTRL_DEBUGBREAK` manager for stopOnEntry tests).
     */
    public async startManagerByNum(managerNum: number): Promise<void> {
        this.requireAvailable();
        const info = this.resolveInstallation();
        if (!info) throw new Error('[WinccoaProjectLifecycle] WinCC OA installation not found');

        const pmon = new PmonComponent();
        pmon.setVersion(info.version);

        const list = await pmon.getManagerOptionsList(this.projName);
        const idx = list.findIndex((m) =>
            m.startOptions?.includes(`-num ${managerNum}`),
        );
        if (idx < 0) {
            throw new Error(
                `[WinccoaProjectLifecycle] No manager with -num ${managerNum} found in manager list`,
            );
        }
        console.log(
            `[WinccoaProjectLifecycle] Starting manager -num ${managerNum} (index ${idx})…`,
        );
        await pmon.startManager(this.projName, idx);
    }

    /**
     * Stops a specific CTRL manager identified by its `-num N` flag.
     */
    public async stopManagerByNum(managerNum: number): Promise<void> {
        this.requireAvailable();
        const info = this.resolveInstallation();
        if (!info) throw new Error('[WinccoaProjectLifecycle] WinCC OA installation not found');

        const pmon = new PmonComponent();
        pmon.setVersion(info.version);

        const list = await pmon.getManagerOptionsList(this.projName);
        const idx = list.findIndex((m) =>
            m.startOptions?.includes(`-num ${managerNum}`),
        );
        if (idx < 0) {
            throw new Error(
                `[WinccoaProjectLifecycle] No manager with -num ${managerNum} found in manager list`,
            );
        }
        console.log(
            `[WinccoaProjectLifecycle] Stopping manager -num ${managerNum} (index ${idx})…`,
        );
        await pmon.stopManager(this.projName, idx);
    }

    private requireAvailable(): void {
        if (!this.isWinccoaAvailable()) {
            throw new Error(
                '[WinccoaProjectLifecycle] WinCC OA is not available on this machine. ' +
                    'Set WINCCOA_SKIP=1 to explicitly opt-out or install WinCC OA.',
            );
        }
    }

    /**
     * Replaces <WinCC_OA_PATH>, <WinCC_OA_VERSION>, and <PROJ_DIR> placeholders in every
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
            if (
                !content.includes('<WinCC_OA_PATH>') &&
                !content.includes('<WinCC_OA_VERSION>') &&
                !content.includes('<PROJ_DIR>')
            ) {
                continue;
            }
            content = content
                .replace(/<WinCC_OA_PATH>/g, info.installPath)
                .replace(/<WinCC_OA_VERSION>/g, info.version)
                .replace(/<PROJ_DIR>/g, this.projPath);
            fs.writeFileSync(filePath, content, 'utf-8');
        }
    }

    /**
     * Reverses substituteConfigPlaceholders() — restores template placeholders so
     * the config files stay as committed templates in version control.
     */
    private restoreConfigPlaceholders(): void {
        if (process.env['WINCCOA_EXTERNAL'] === '1') {
            // Runner owns the config files — skip per-file restore to avoid clobbering
            return;
        }
        // Restore placeholders whenever this instance registered the project
        // (matches the always-unregister behaviour of stop()).
        if (!this.didRegisterProject) {
            return;
        }
        const info = this.resolveInstallation();
        if (!info) return;

        const configDir = path.join(this.projPath, 'config');
        if (!fs.existsSync(configDir)) return;

        for (const file of fs.readdirSync(configDir)) {
            const filePath = path.join(configDir, file);
            if (!fs.statSync(filePath).isFile()) continue;
            let content = fs.readFileSync(filePath, 'utf-8');
            // Only process files that contain substituted values
            if (
                !content.includes(info.installPath) &&
                !content.includes(info.version) &&
                !content.includes(this.projPath)
            ) {
                continue;
            }
            content = content
                .replace(new RegExp(escapeRegExp(this.projPath), 'g'), '<PROJ_DIR>')
                .replace(new RegExp(escapeRegExp(info.installPath), 'g'), '<WinCC_OA_PATH>')
                .replace(new RegExp(escapeRegExp(info.version), 'g'), '<WinCC_OA_VERSION>');
            fs.writeFileSync(filePath, content, 'utf-8');
        }
    }

    /**
     * Copies all *.sqlite files from the shared seeds directory into the project's
     * db/wincc_oa/sqlite/ folder.  This resets the database to a known-good state
     * before every test run, preventing stale data from prior runs.
     */
    private restoreDbFromSeed(): void {
        const targetDir = path.join(this.projPath, 'db', 'wincc_oa', 'sqlite');
        if (!fs.existsSync(SEEDS_SQLITE_DIR)) {
            console.warn(
                `[WinccoaProjectLifecycle] Seed directory not found: ${SEEDS_SQLITE_DIR} — skipping DB restore`,
            );
            return;
        }
        fs.mkdirSync(targetDir, { recursive: true });
        for (const file of fs.readdirSync(SEEDS_SQLITE_DIR)) {
            if (!file.endsWith('.sqlite')) continue;
            const src = path.join(SEEDS_SQLITE_DIR, file);
            const dst = path.join(targetDir, file);
            fs.copyFileSync(src, dst);
        }
        console.log(`[WinccoaProjectLifecycle] DB restored from seeds (${SEEDS_SQLITE_DIR})`);
    }

    /**
     * Returns true when this project's path is already listed as an InstallationDir
     * in pvssInst.conf — indicating that the project was registered (e.g. by the
     * VS Code Project Admin extension) before the test run started.
     * In that case start() skips registration and stop() skips unregistration,
     * so the project remains visible to other tools after the test suite finishes.
     */
    private isProjectRegisteredInPvssConf(): boolean {
        const pvssInstConfPath =
            process.platform === 'win32'
                ? 'C:\\ProgramData\\Siemens\\WinCC_OA\\pvssInst.conf'
                : '/etc/opt/pvss/pvssInst.conf';
        try {
            const content = fs.readFileSync(pvssInstConfPath, 'utf-8');
            // Each registered project has a line:  InstallationDir = "/path/to/project"
            return content.includes(this.projPath);
        } catch {
            return false;
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

}
