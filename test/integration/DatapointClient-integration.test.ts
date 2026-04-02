import test from 'node:test';
import assert from 'node:assert/strict';
import { DatapointClient, DatapointConfig } from '../../src/connection/DatapointClient';
import { printLocalIntegrationTestResult } from '../helpers/integration-teardown.js';

/**
 * Integration test for DatapointClient with real WinCC OA system
 * 
 * Prerequisites:
 * - WinCC OA installed at /opt/WinCC_OA/3.21
 * - Test project available
 * - CTRL Manager running with debug enabled
 */

let client: DatapointClient | null = null;
let testOutput = {
    status: 0,
    signal: null as NodeJS.Signals | null,
    stdout: '',
    stderr: '',
};

test.before(async () => {
    testOutput.stdout += 'Preparing DatapointClient integration test...\n';
});

test('DatapointClient Integration: Connect to WinCC OA', async () => {
    const config: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
    };

    client = new DatapointClient(config);

    // Setup event listeners for debugging
    client.on('connected', () => {
        testOutput.stdout += 'Connected to WinCC OA\n';
    });

    client.on('disconnected', () => {
        testOutput.stdout += 'Disconnected from WinCC OA\n';
    });

    client.on('error', (err) => {
        testOutput.stderr += `Error: ${err.message}\n`;
    });

    try {
        await client.connect();
        testOutput.stdout += `Successfully connected to ${config.host}:${config.port}\n`;
        testOutput.stdout += `Debug datapoint: ${client.getDebugDp()}\n`;
        assert.ok(client.isConnected());
    } catch (err) {
        testOutput.stderr += `Connection failed: ${(err as Error).message}\n`;
        testOutput.stderr += 'Note: This test requires a running WinCC OA system\n';
        testOutput.status = 1;
        throw err;
    }
});

test('DatapointClient Integration: Send debug command', async () => {
    if (!client || !client.isConnected()) {
        testOutput.stderr += 'Skipping: Not connected to WinCC OA\n';
        return;
    }

    try {
        // Send a simple info command
        testOutput.stdout += 'Sending "info threads" command...\n';
        const result = await client.sendCommand('info threads', 10000);
        
        testOutput.stdout += `Received response with ${result.length} items:\n`;
        result.forEach((item, idx) => {
            testOutput.stdout += `  [${idx}]: ${item}\n`;
        });

        assert.ok(Array.isArray(result));
    } catch (err) {
        testOutput.stderr += `Command failed: ${(err as Error).message}\n`;
        testOutput.status = 1;
        throw err;
    }
});

test('DatapointClient Integration: Disconnect from WinCC OA', async () => {
    if (!client) {
        testOutput.stderr += 'Skipping: No client to disconnect\n';
        return;
    }

    try {
        await client.disconnect();
        testOutput.stdout += 'Successfully disconnected\n';
        assert.ok(!client.isConnected());
    } catch (err) {
        testOutput.stderr += `Disconnect failed: ${(err as Error).message}\n`;
        testOutput.status = 1;
        throw err;
    }
});

test.after(() => {
    try {
        printLocalIntegrationTestResult('DatapointClient-integration', testOutput);
    } catch (err) {
        console.warn('Failed to print integration test result:', err);
    }
});
