#!/usr/bin/env node
/**
 * CLI for WinCC OA Debug Adapter
 *
 * Usage:
 *   winccoa-debug-adapter --project DevEnv3.21 --system System1 --manager ctrl:1
 *   winccoa-debug-adapter --stdio          # DAP over stdin/stdout (no bootstrap)
 *   winccoa-debug-adapter --tcp-port 4711  # DAP over TCP (started via bootstrap.js)
 */

import { DatapointClient, DatapointConfig } from './connection/DatapointClient';
import { WinCCDebugSession } from './adapter/WinCCDebugSession';

interface CLIArgs {
    host?: string;
    port?: number;
    project?: string; // WinCC OA project name for -proj arg (e.g. DevEnv3.21)
    system?: string;  // WinCC OA system name for DP prefix (e.g. System1)
    manager?: string; // Format: "ctrl:1" or "ui:5"
    user?: string;    // WinCC OA username
    pass?: string;    // WinCC OA password
    stdio?: boolean;
    tcpPort?: number; // DAP over TCP (used when started via bootstrap.js)
    testConnect?: boolean;
}

function parseArgs(args: string[]): CLIArgs {
    const result: CLIArgs = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--host':
                result.host = args[++i];
                break;
            case '--port':
                result.port = parseInt(args[++i], 10);
                break;
            case '--project':
                result.project = args[++i];
                break;
            case '--system':
                result.system = args[++i];
                break;
            case '--manager':
                result.manager = args[++i];
                break;
            case '--user':
                result.user = args[++i];
                break;
            case '--pass':
                result.pass = args[++i];
                break;
            case '--stdio':
                result.stdio = true;
                break;
            case '--tcp-port':
                result.tcpPort = parseInt(args[++i], 10);
                break;
            case '--test-connect':
                result.testConnect = true;
                break;
            case '--help':
            case '-h':
                printUsage();
                process.exit(0);
        }
    }

    return result;
}

function printUsage() {
    process.stderr.write(`
WinCC OA Debug Adapter

Usage:
  winccoa-debug-adapter [options]

Options:
  --project <name>     WinCC OA project name (e.g. DevEnv3.21)
  --system <name>      WinCC OA system name for DP prefix (default: System1)
  --host <host>        WinCC OA host (default: localhost)
  --port <port>        WinCC OA dist port (default: 4999)
  --manager <type:num> Manager to debug (e.g., ctrl:1)
  --stdio              Run DAP server on stdin/stdout (no bootstrap)
  --tcp-port <port>    Run DAP server on TCP port (use with bootstrap.js)
  --test-connect       Test WinCC OA connection and exit
  --help, -h           Show this help
`);
}

async function runInteractiveMode(config: DatapointConfig) {
    process.stderr.write('WinCC OA Debug Adapter - Interactive Mode\n');
    process.stderr.write('Connecting to: ' + JSON.stringify(config) + '\n');

    const client = new DatapointClient(config);

    client.on('connected', () => {
        process.stderr.write('✓ Connected to WinCC OA\n');
        process.stderr.write('  Debug datapoint: ' + client.getDebugDp() + '\n');
    });

    client.on('disconnected', () => {
        process.stderr.write('✗ Disconnected from WinCC OA\n');
    });

    client.on('error', (err) => {
        process.stderr.write('Error: ' + (err as Error).message + '\n');
    });

    client.on('message', (msg) => {
        process.stderr.write('Unsolicited message: ' + JSON.stringify(msg) + '\n');
    });

    try {
        await client.connect();

        // Simple test: query info breakpoints (works even without active debug stop)
        process.stderr.write('\nSending test command: info breakpoints\n');
        const result = await client.sendCommand('info breakpoints', 5000);
        process.stderr.write('Result: ' + JSON.stringify(result) + '\n');

        await client.disconnect();
        process.stderr.write('\nTest completed successfully\n');
        process.exit(0);
    } catch (err) {
        process.stderr.write('Failed: ' + (err as Error).message + '\n');
        process.exit(1);
    }
}

function runStdioMode(): void {
    // Start the DAP session: reads from stdin, writes to stdout.
    // Only use this when NOT started via bootstrap.js (stdout is clean).
    WinCCDebugSession.run(WinCCDebugSession);
}

function runTcpMode(tcpPort: number): void {
    // The @vscode/debugadapter runDebugAdapter helper already supports TCP server
    // mode when '--server=PORT' is in process.argv. We inject that flag so that
    // WinCCDebugSession.run() picks it up and starts a TCP listener on the given port.
    // Used when the adapter is started via bootstrap.js (stdout redirected to stderr).
    process.argv.push(`--server=${tcpPort}`);
    WinCCDebugSession.run(WinCCDebugSession);
}

async function main() {
    process.stderr.write('[winccoa-debugger] Starting, process.argv: ' + process.argv.join(' ') + '\n');

    // bootstrap.js shifts process.argv so argv[0] = our script, argv[1] = first flag.
    // Normal invocation: argv[0]=node, argv[1]=script, argv[2+]=flags.
    const flagStart = process.argv.findIndex(a => a.startsWith('--') || a === '-h');
    const args = parseArgs(flagStart >= 0 ? process.argv.slice(flagStart) : []);

    process.stderr.write('[winccoa-debugger] Parsed args: ' + JSON.stringify(args) + '\n');

    if (args.stdio) {
        runStdioMode();
        return;
    }

    if (args.tcpPort) {
        // Started via bootstrap.js — WinCC OA connection is already established.
        // Just open the TCP server for VS Code to connect.
        runTcpMode(args.tcpPort);
        return;
    }

    if (args.testConnect) {
        // Started via bootstrap.js for connection testing.
        const config: DatapointConfig = {
            host: args.host || 'localhost',
            port: args.port || 4999,
            system: args.system || 'System1',
            managerType: 'CTRL',
            managerNumber: 1,
        };
        await runInteractiveMode(config);
        return;
    }

    // Direct invocation (not via bootstrap) — inject connectionArgs.
    let managerType: DatapointConfig['managerType'] = 'CTRL';
    let managerNumber = 1;
    if (args.manager) {
        const [type, num] = args.manager.split(':');
        managerType = type.toUpperCase() as DatapointConfig['managerType'];
        managerNumber = parseInt(num, 10);
    }

    const config: DatapointConfig = {
        host: args.host || 'localhost',
        port: args.port || 4999,
        system: args.system || 'System1',
        managerType,
        managerNumber,
        connectionArgs: [
            '-proj', args.project || args.system || 'System1',
            '-host', args.host || 'localhost',
            '-port', String(args.port || 4999),
            '-num',  '99',
            '-m',    'jscript',
            ...(args.user ? ['-user', args.user, '-pass', args.pass ?? ''] : []),
        ],
    };

    await runInteractiveMode(config);
}

main().catch((err) => {
    process.stderr.write('Fatal error: ' + String(err) + '\n');
    process.exit(1);
});

