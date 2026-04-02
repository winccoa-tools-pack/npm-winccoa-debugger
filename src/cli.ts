#!/usr/bin/env node
/**
 * CLI for WinCC OA Debug Adapter
 *
 * Usage:
 *   winccoa-debug-adapter --host localhost --port 4999 --system System1 --manager ctrl:1
 *   winccoa-debug-adapter --stdio   # Run as DAP server on stdin/stdout
 */

import { DatapointClient, DatapointConfig } from './connection/DatapointClient';

interface CLIArgs {
    host?: string;
    port?: number;
    system?: string;
    manager?: string; // Format: "ctrl:1" or "ui:5"
    stdio?: boolean;
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
            case '--system':
                result.system = args[++i];
                break;
            case '--manager':
                result.manager = args[++i];
                break;
            case '--stdio':
                result.stdio = true;
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
    console.log(`
WinCC OA Debug Adapter

Usage:
  winccoa-debug-adapter [options]

Options:
  --host <host>        WinCC OA host (default: localhost)
  --port <port>        WinCC OA dist port (default: 4999)
  --system <system>    WinCC OA system name (default: System1)
  --manager <type:num> Manager to debug (e.g., ctrl:1, ui:5)
  --stdio              Run as DAP server on stdin/stdout
  --help, -h           Show this help

Examples:
  # Test connection to CTRL manager 1
  winccoa-debug-adapter --host localhost --port 4999 --system System1 --manager ctrl:1

  # Run as DAP server
  winccoa-debug-adapter --stdio
`);
}

async function runInteractiveMode(config: DatapointConfig) {
    console.log('WinCC OA Debug Adapter - Interactive Mode');
    console.log('Connecting to:', config);

    const client = new DatapointClient(config);

    client.on('connected', () => {
        console.log('✓ Connected to WinCC OA');
        console.log('  Debug datapoint:', client.getDebugDp());
    });

    client.on('disconnected', () => {
        console.log('✗ Disconnected from WinCC OA');
    });

    client.on('error', (err) => {
        console.error('Error:', err.message);
    });

    client.on('message', (msg) => {
        console.log('Unsolicited message:', msg);
    });

    try {
        await client.connect();

        // Simple test: query threads
        console.log('\nSending test command: info threads');
        const result = await client.sendCommand('info threads', 5000);
        console.log('Result:', result);

        await client.disconnect();
        console.log('\nTest completed successfully');
        process.exit(0);
    } catch (err) {
        console.error('Failed:', (err as Error).message);
        process.exit(1);
    }
}

async function runStdioMode() {
    console.error('DAP stdio mode not implemented yet');
    console.error('Use WinCCDebugSession class for DAP server functionality');
    process.exit(1);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.stdio) {
        await runStdioMode();
        return;
    }

    // Parse manager type and number
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
    };

    await runInteractiveMode(config);
}

// Run CLI
main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
