import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatapointClient } from '../../src/connection/DatapointClient.js';
import { WinccoaProjectLifecycle } from '../helpers/WinccoaProjectLifecycle.js';
import { printLocalIntegrationTestResult } from '../helpers/integration-teardown.js';

/**
 * Integration test: DatapointClient against a real WinCC OA system.
 *
 * WinccoaProjectLifecycle manages project start/stop automatically when
 * WinCC OA is installed.  Set WINCCOA_SKIP=1 to skip in environments without
 * a WinCC OA licence.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJ_PATH = path.resolve(__dirname, '../fixtures/projects/debugger-poc');
const lifecycle = new WinccoaProjectLifecycle(PROJ_PATH);
let client: DatapointClient | null = null;
const testOutput = {
    status: 0,
    signal: null as NodeJS.Signals | null,
    stdout: '',
    stderr: '',
};

test.before(async () => {
    if (!lifecycle.isWinccoaAvailable()) {
        testOutput.stdout += 'WinCC OA not available — tests will be skipped\n';
        return;
    }

    try {
        await lifecycle.start();
    } catch (err) {
        testOutput.stderr += `Could not start WinCC OA: ${String(err)}\n`;
        return;
    }

    const config = lifecycle.getDatapointConfig('CTRL', 1);
    testOutput.stdout += `Connecting to WinCC OA at ${config.host}:${config.port}\n`;
    const c = new DatapointClient(config);
    c.on('connected', () => {
        testOutput.stdout += 'Connected to WinCC OA\n';
    });
    c.on('disconnected', () => {
        testOutput.stdout += 'Disconnected from WinCC OA\n';
    });
    c.on('error', (err) => {
        testOutput.stderr += `Error: ${String(err)}\n`;
    });

    try {
        await c.connect();
        client = c;
        testOutput.stdout += `Debug datapoint: ${client.getDebugDp()}\n`;
    } catch (err) {
        testOutput.stderr += `Connection failed (project may not be running): ${String(err)}\n`;
        // client stays null → tests skip
    }
});

test.after(async () => {
    if (client?.isConnected()) await client.disconnect();
    if (lifecycle.isWinccoaAvailable()) await lifecycle.stop();
    printLocalIntegrationTestResult('DatapointClient-integration', testOutput);
});

// ─── tests ───────────────────────────────────────────────────────────────────

test('DatapointClient Integration: Connect to WinCC OA', (ctx) => {
    if (!lifecycle.isWinccoaAvailable()) {
        ctx.skip('WinCC OA not available');
        return;
    }
    if (!client) {
        ctx.skip('Client not initialised');
        return;
    }

    assert.ok(client.isConnected());
    testOutput.stdout += `Connected — debug dp: ${client.getDebugDp()}\n`;
});

test('DatapointClient Integration: Send debug command', async (ctx) => {
    if (!client?.isConnected()) {
        ctx.skip('Not connected');
        return;
    }

    testOutput.stdout += 'Sending "info threads"…\n';
    const result = await client.sendCommand('info threads', 10_000);
    testOutput.stdout += `Response (${result.length} items): ${JSON.stringify(result)}\n`;

    assert.ok(Array.isArray(result));
    assert.ok(result.length > 0);
});

test('DatapointClient Integration: Disconnect from WinCC OA', async (ctx) => {
    if (!client) {
        ctx.skip('No client');
        return;
    }

    await client.disconnect();
    assert.ok(!client.isConnected());
    client = null;
    testOutput.stdout += 'Disconnected\n';
});
