#!/usr/bin/env node
/**
 * CLI for WinCC OA Debug Adapter
 *
 * Usage:
 *   winccoa-debug-adapter --project DevEnv3.21 --system System1 --manager ctrl:5
 *   winccoa-debug-adapter --stdio          # DAP over stdin/stdout (no bootstrap)
 *   winccoa-debug-adapter --tcp-port 4711  # DAP over TCP (started via bootstrap.js)
 *   winccoa-debug-adapter --repl           # Interactive REPL (must be started via bootstrap.js)
 */

import * as readline from 'readline';
import { DatapointClient, DatapointConfig } from './connection/DatapointClient';
import { WinCCDebugSession } from './adapter/WinCCDebugSession';

interface CLIArgs {
    host?: string;
    port?: number;
    project?: string; // WinCC OA project name for -proj arg (e.g. DevEnv3.21)
    system?: string;  // WinCC OA system name for DP prefix (e.g. System1)
    manager?: string; // Format: "ctrl:5" — the CTRL manager to debug (not the adapter's own number)
    adapterNum?: number; // Adapter's own manager number (default 99)
    user?: string;    // WinCC OA username
    pass?: string;    // WinCC OA password
    stdio?: boolean;
    tcpPort?: number; // DAP over TCP (used when started via bootstrap.js)
    testConnect?: boolean;
    testEcho?: boolean;  // Test round-trip against simple TestEcho_1 DP (no debug DP needed)
    repl?: boolean;   // Interactive REPL mode for manual protocol testing
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
            case '--adapter-num':
                result.adapterNum = parseInt(args[++i], 10);
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
            case '--test-echo':
                result.testEcho = true;
                break;
            case '--repl':
                result.repl = true;
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
  --project <name>          WinCC OA project name (e.g. DevEnv3.21)
  --system <name>           WinCC OA system name for DP prefix (default: System1)
  --host <host>             WinCC OA host (default: localhost)
  --port <port>             WinCC OA dist port (default: 4999)
  --manager <type:num>      Manager to debug — its debug DPs are read (e.g., ctrl:5)
  --adapter-num <num>       This adapter's own manager number (default: 99)
  --stdio                   Run DAP server on stdin/stdout (no bootstrap)
  --tcp-port <port>         Run DAP server on TCP port (use with bootstrap.js)
  --test-connect            Test WinCC OA connection, print DP info, and exit
  --repl                    Interactive REPL: connect and send debug commands manually
  --help, -h                Show this help

Examples (direct invocation — injects connection args automatically):
  # Interactive REPL against CTRL manager 5:
  node dist/cjs/cli.js --project DevEnv3.21 --manager ctrl:5 --repl

  # Quick connection test:
  node dist/cjs/cli.js --project DevEnv3.21 --manager ctrl:5 --test-connect

Examples (via bootstrap.js — WinCC OA connection already established):
  /opt/WinCC_OA/3.21/bin/bootstrap.js -PROJ DevEnv3.21 -pmonIndex 99 \\
    node dist/cjs/cli.js --repl --manager ctrl:5
`);
}

/** * Echo-DP round-trip test.
 *
 * Connects to WinCC OA, subscribes to TestEcho_1.Output, writes a payload to
 * TestEcho_1.Input, and waits for the echo server CTL script to reflect it back.
 * This verifies that dpSetWait + dpConnect callbacks work correctly from Node.js
 * WITHOUT needing the debug DP protocol.
 *
 * Prerequisite: test_echo_server.ctl must be running as a WinCC OA manager.
 * progs entry:  WCCOActrl | manual | 30 | 3 | 1 | -num 6 test_echo_server.ctl
 */
async function runTestEcho(config: DatapointConfig): Promise<void> {
    const system  = config.system ? config.system + ':' : '';
    const inputDpe  = `${system}TestEcho_1.Input`;
    const outputDpe = `${system}TestEcho_1.Output`;

    process.stderr.write('WinCC OA Debug Adapter - Echo Round-Trip Test\n');
    process.stderr.write(`  Input  DPE: ${inputDpe}\n`);
    process.stderr.write(`  Output DPE: ${outputDpe}\n\n`);

    // We connect directly to WinCC OA using the same mechanism as DatapointClient,
    // but using a minimal inline setup so we can subscribe to arbitrary DPEs.
    const client = new DatapointClient(config);

    // Temporarily override: subscribe to Output instead of .Result
    // We do this by creating a second client pointed at the echo DP directly.
    // Simpler: just re-use the existing DatapointClient with a fake managerType
    // that results in the correct DP name.  Instead, use the winccoa-manager
    // directly via the client's internal (we can access it via test-connect pattern).

    // Since DatapointClient only exposes sendCommand on the debug DP, we build a
    // minimal standalone test using the winccoa-manager directly:
    await client.connect();  // establishes the WinccoaManager connection

    // Access the internal api via a cast — for test purposes only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (client as any).api as {
        dpConnect(cb: (names: string[], values: any[]) => void, dpe: string, answer?: boolean): number;
        dpSetWait(dpe: string, value: any): Promise<void>;
        dpDisconnect(id: number): void;
    };

    process.stderr.write('✓ Connected\n');

    // Subscribe to Output
    let resolveEcho: (v: string) => void;
    let rejectEcho: (e: Error) => void;
    const echoPromise = new Promise<string>((res, rej) => {
        resolveEcho = res;
        rejectEcho  = rej;
    });

    const subId = api.dpConnect((names, values) => {
        process.stderr.write(`[echo] dpConnect callback: names=${JSON.stringify(names)} values=${JSON.stringify(values)}\n`);
        const val = values[0];
        if (val && val !== '' && val !== '{}') {
            resolveEcho!(String(val));
        }
    }, outputDpe, false);

    if (subId < 0) {
        process.stderr.write(`✗ dpConnect failed for "${outputDpe}" (id=${subId})\n`);
        process.stderr.write('  → Is test_echo_server.ctl running? (progs: -num 6 test_echo_server.ctl)\n');
        process.exit(1);
    }
    process.stderr.write(`✓ Subscribed to ${outputDpe} (subId=${subId})\n`);

    // Send payload to Input
    const id      = `${Date.now()}-echo-test`;
    const payload = JSON.stringify({ id, echo: 'hello from Node.js' });

    process.stderr.write(`\nSending to ${inputDpe}: ${payload}\n`);
    try {
        await api.dpSetWait(inputDpe, payload);
        process.stderr.write('✓ dpSetWait confirmed\n');
    } catch (e) {
        process.stderr.write(`✗ dpSetWait failed: ${(e as Error).message}\n`);
        process.exit(1);
    }

    // Wait for echo (max 5s)
    const timer = setTimeout(() => rejectEcho!(new Error('Echo timeout after 5000ms')), 5000);
    try {
        const response = await echoPromise;
        clearTimeout(timer);
        process.stderr.write(`\n✓ Echo received: ${response}\n`);

        const parsed = JSON.parse(response) as { id: string; echoed: string };
        if (parsed.id === id && parsed.echoed === 'hello from Node.js') {
            process.stderr.write('✓ Round-trip complete — dpSetWait + dpConnect works correctly!\n');
        } else {
            process.stderr.write(`✗ Unexpected response content: ${response}\n`);
        }
    } catch (e) {
        process.stderr.write(`✗ ${(e as Error).message}\n`);
        process.stderr.write('  → Is test_echo_server.ctl running?\n');
        process.exit(1);
    } finally {
        api.dpDisconnect(subId);
        await client.disconnect();
    }
    process.exit(0);
}

/** * Quick connection test — connect, print the debug DP name, send "info scripts",
 * and exit. Useful to verify that the DP protocol works before using VS Code.
 */
async function runTestConnect(config: DatapointConfig): Promise<void> {
    process.stderr.write('WinCC OA Debug Adapter - Connection Test\n');
    process.stderr.write('Target DP: ' + buildDebugDpName(config) + '\n\n');

    const client = new DatapointClient(config);

    client.on('connected', () => {
        process.stderr.write('✓ Connected to WinCC OA\n');
        process.stderr.write('  Debug datapoint: ' + client.getDebugDp() + '\n');
    });
    client.on('error', (err) => {
        process.stderr.write('Error: ' + (err as Error).message + '\n');
    });
    client.on('message', (msg) => {
        process.stderr.write('[unsolicited] ' + JSON.stringify(msg) + '\n');
    });

    try {
        await client.connect();

        process.stderr.write('\nQuerying loaded scripts...\n');
        const scripts = await client.sendCommand('info scripts', 5000);
        process.stderr.write('info scripts result:\n');
        scripts.forEach((l) => process.stderr.write('  ' + l + '\n'));

        process.stderr.write('\nQuerying breakpoints...\n');
        const bps = await client.sendCommand('info breakpoints', 5000);
        process.stderr.write('info breakpoints result:\n');
        bps.forEach((l) => process.stderr.write('  ' + l + '\n'));

        await client.disconnect();
        process.stderr.write('\n✓ Test completed successfully\n');
        process.exit(0);
    } catch (err) {
        process.stderr.write('✗ Failed: ' + (err as Error).message + '\n');
        process.exit(1);
    }
}

/**
 * Interactive REPL — connect to WinCC OA and read debug commands from stdin.
 *
 * Unsolicited messages (breakpoint hits, etc.) are printed immediately.
 * Type "help" for available commands, "quit" or Ctrl-D to exit.
 *
 * Example usage (via bootstrap.js):
 *   > info scripts
 *   > breakpoint {"scriptId": 1, "line": 24}
 *   > continue
 *   > info locals
 *   > bt
 */
async function runRepl(config: DatapointConfig): Promise<void> {
    process.stderr.write('WinCC OA Debug Adapter — Interactive REPL\n');
    process.stderr.write('Target DP: ' + buildDebugDpName(config) + '\n');
    process.stderr.write('Connecting...\n\n');

    const client = new DatapointClient(config);

    client.on('connected', () => {
        process.stderr.write('✓ Connected. Debug DP: ' + client.getDebugDp() + '\n\n');
        process.stderr.write('Commands: info scripts | info breakpoints | info threads | info locals\n');
        process.stderr.write('          breakpoint {"scriptId":N,"line":M} | continue | next | step\n');
        process.stderr.write('          bt | finish | interrupt | print <expr> | quit\n\n');
    });

    client.on('disconnected', () => {
        process.stderr.write('\n✗ Disconnected from WinCC OA\n');
        process.exit(0);
    });

    client.on('error', (err) => {
        process.stderr.write('Error: ' + (err as Error).message + '\n');
    });

    // Print breakpoint hits and other unsolicited stop events immediately,
    // interrupting any ongoing readline prompt.
    client.on('message', (msg: string[]) => {
        process.stderr.write('\n[STOP EVENT] ' + JSON.stringify(msg) + '\n');
        if (msg[0]?.startsWith('line: ')) {
            const line = msg[0].slice(6);
            const thread = msg.find((m) => m.startsWith('ThreadId:')) ?? '';
            process.stderr.write(`  → Stopped at line ${line}  ${thread}\n`);
        }
        process.stderr.write('> ');
    });

    await client.connect();

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
        prompt: '> ',
    });

    rl.prompt();

    rl.on('line', async (line) => {
        const cmd = line.trim();
        if (!cmd) {
            rl.prompt();
            return;
        }
        if (cmd === 'quit' || cmd === 'exit') {
            await client.disconnect();
            rl.close();
            process.exit(0);
        }
        if (cmd === 'help') {
            process.stderr.write('Available commands:\n');
            process.stderr.write('  info scripts              — list loaded CTL scripts with their IDs\n');
            process.stderr.write('  info breakpoints          — list active breakpoints\n');
            process.stderr.write('  info threads              — list CTRL threads\n');
            process.stderr.write('  info locals               — show local variables at current stop\n');
            process.stderr.write('  breakpoint {"scriptId":N,"line":M}  — set breakpoint\n');
            process.stderr.write('  continue                  — resume execution\n');
            process.stderr.write('  next                      — step over\n');
            process.stderr.write('  step                      — step into\n');
            process.stderr.write('  finish                    — step out\n');
            process.stderr.write('  interrupt                 — pause running script\n');
            process.stderr.write('  bt                        — show call stack\n');
            process.stderr.write('  print <expr>              — evaluate expression\n');
            process.stderr.write('  quit / exit               — disconnect and exit\n');
            rl.prompt();
            return;
        }

        try {
            const result = await client.sendCommand(cmd, 10000);
            if (result.length === 0) {
                process.stderr.write('(empty response)\n');
            } else {
                result.forEach((l) => process.stderr.write('  ' + l + '\n'));
            }
        } catch (err) {
            process.stderr.write('Error: ' + (err as Error).message + '\n');
        }

        rl.prompt();
    });

    rl.on('close', async () => {
        await client.disconnect().catch(() => {});
        process.exit(0);
    });
}

/** Build the debug DP name string (for display only). */
function buildDebugDpName(config: DatapointConfig): string {
    const prefix = config.system ? config.system + ':' : '';
    return `${prefix}_CtrlDebug_${config.managerType}_${config.managerNumber}.*`;
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

    // Parse the target manager (whose debug DPs we read).
    let managerType: DatapointConfig['managerType'] = 'CTRL';
    let managerNumber = 1;
    if (args.manager) {
        const parts = args.manager.split(':');
        managerType = parts[0].toUpperCase() as DatapointConfig['managerType'];
        managerNumber = parseInt(parts[1] ?? '1', 10);
    }

    // If --project is given, we're running directly (not via bootstrap.js) and need
    // to inject connectionArgs so the native addon can authenticate with WinCC OA.
    // If --project is NOT given, bootstrap.js already set up the connection.
    const adapterNum = args.adapterNum ?? 99;
    const needsConnectionArgs = !!args.project;

    const config: DatapointConfig = {
        host: args.host || 'localhost',
        port: args.port || 4999,
        system: args.system || 'System1',
        managerType,
        managerNumber,
        ...(needsConnectionArgs
            ? {
                connectionArgs: [
                    '-proj', args.project!,
                    '-host', args.host || 'localhost',
                    '-port', String(args.port || 4999),
                    '-num', String(adapterNum),
                    '-m',   'jscript',
                    ...(args.user ? ['-user', args.user, '-pass', args.pass ?? ''] : []),
                ],
              }
            : {}),
    };

    if (args.testConnect) {
        await runTestConnect(config);
        return;
    }

    if (args.testEcho) {
        await runTestEcho(config);
        return;
    }

    if (args.repl) {
        await runRepl(config);
        return;
    }

    // Default: start interactive REPL (direct invocation with connectionArgs).
    await runRepl(config);
}

main().catch((err) => {
    process.stderr.write('Fatal error: ' + String(err) + '\n');
    process.exit(1);
});

