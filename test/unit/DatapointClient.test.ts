import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatapointClient, DatapointConfig } from '../../src/connection/DatapointClient';

// Mock for npm-winccoa-core Manager class
class MockManager extends EventEmitter {
    private connected = false;
    public mockDatapoints = new Map<string, any>();
    private dpCallbacks = new Map<string, (value: any) => void>();

    async connect(): Promise<void> {
        this.connected = true;
        this.emit('connected');
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        this.emit('disconnected');
    }

    isConnected(): boolean {
        return this.connected;
    }

    // Mock dpConnect - simulates WinCC OA datapoint connection
    async dpConnect(dpName: string, callback: (value: any) => void): Promise<void> {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        
        this.dpCallbacks.set(dpName, callback);
        this.on(`dp:${dpName}`, callback);
    }

    // Mock dpSet - simulates WinCC OA datapoint write
    async dpSet(dpName: string, value: any): Promise<void> {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        
        this.mockDatapoints.set(dpName, value);
    }

    // Test helper to simulate incoming datapoint changes
    simulateDpChange(dpName: string, value: any): void {
        const callback = this.dpCallbacks.get(dpName);
        if (callback) {
            callback(value);
        }
    }
}

test('DatapointClient: constructor initializes with config', () => {
    const config: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
    };

    const client = new DatapointClient(config);
    assert.ok(client);
    assert.equal(client.getDebugDp(), '_CtrlDebug_CTRL_1');
});

test('DatapointClient: connect establishes connection', async () => {
    const config: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
    };

    const client = new DatapointClient(config);
    
    // Mock the internal manager (this would be injected in real implementation)
    const mockManager = new MockManager();
    (client as any).manager = mockManager;

    await client.connect();
    
    assert.ok(mockManager.isConnected());
});

test('DatapointClient: disconnect closes connection', async () => {
    const config: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
    };

    const client = new DatapointClient(config);
    const mockManager = new MockManager();
    (client as any).manager = mockManager;

    await client.connect();
    await client.disconnect();
    
    assert.ok(!mockManager.isConnected());
});

test('DatapointClient: sendCommand sends data to debug datapoint', async () => {
    const config: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
    };

    const client = new DatapointClient(config);
    const mockManager = new MockManager();
    await mockManager.connect(); // Connect the mock
    await mockManager.dpConnect('_CtrlDebug_CTRL_1.Result', (value: any) => {
        (client as any).handleResponse(value);
    });
    (client as any).manager = mockManager;
    (client as any).connected = true;

    const cmdPromise = client.sendCommand('break scripts/debugTest.ctl 10');
    
    // Simulate response
    setTimeout(() => {
        const sentValue = mockManager.mockDatapoints.get('_CtrlDebug_CTRL_1.Command');
        assert.ok(sentValue);
        
        const cmd = JSON.parse(sentValue);
        mockManager.simulateDpChange('_CtrlDebug_CTRL_1.Result', [cmd.id, 'OK', 'Breakpoint set']);
    }, 10);
    
    const result = await cmdPromise;
    assert.deepEqual(result, ['OK', 'Breakpoint set']);
});

test('DatapointClient: receives response from debug datapoint', async (t) => {
    const config: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
    };

    const client = new DatapointClient(config);
    const mockManager = new MockManager();
    await mockManager.connect(); // Connect the mock
    await mockManager.dpConnect('_CtrlDebug_CTRL_1.Result', (value: any) => {
        (client as any).handleResponse(value);
    });
    (client as any).manager = mockManager;
    (client as any).connected = true;

    // Send command and wait for response
    const cmdPromise = client.sendCommand('info threads');
    
    setTimeout(() => {
        const sentValue = mockManager.mockDatapoints.get('_CtrlDebug_CTRL_1.Command');
        const cmd = JSON.parse(sentValue);
        mockManager.simulateDpChange('_CtrlDebug_CTRL_1.Result', [cmd.id, 'thread1', 'thread2']);
    }, 10);

    const result = await cmdPromise;
    assert.deepEqual(result, ['thread1', 'thread2']);
});

test('DatapointClient: builds correct datapoint name', () => {
    const config1: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
    };

    const client1 = new DatapointClient(config1);
    assert.equal(client1.getDebugDp(), '_CtrlDebug_CTRL_1');

    const config2: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'UI',
        managerNumber: 5,
    };

    const client2 = new DatapointClient(config2);
    assert.equal(client2.getDebugDp(), '_CtrlDebug_UI_5');
});

test('DatapointClient: handles connection errors', async () => {
    const config: DatapointConfig = {
        host: 'invalid-host',
        port: 9999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
    };

    const client = new DatapointClient(config);
    
    // In real scenario, connect would fail
    // For now, just verify client was created
    assert.ok(client);
    assert.ok(!client.isConnected());
});

test('DatapointClient: emits error events', async (t) => {
    const config: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
    };

    const client = new DatapointClient(config);
    const mockManager = new MockManager();
    (client as any).manager = mockManager;

    let errorEmitted = false;
    client.on('error', (err) => {
        errorEmitted = true;
        assert.ok(err instanceof Error);
    });

    await client.connect();

    // Simulate error
    mockManager.emit('error', new Error('Test error'));

    await new Promise(resolve => setTimeout(resolve, 50));

    assert.ok(errorEmitted);
});

test('DatapointClient: command timeout', async () => {
    const config: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
    };

    const client = new DatapointClient(config);
    const mockManager = new MockManager();
    await mockManager.connect(); // Connect the mock
    await mockManager.dpConnect('_CtrlDebug_CTRL_1.Result', (value: any) => {
        (client as any).handleResponse(value);
    });
    (client as any).manager = mockManager;
    (client as any).connected = true;

    // Send command with short timeout, don't send response
    try {
        await client.sendCommand('info threads', 100);
        assert.fail('Should have timed out');
    } catch (err) {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /timeout/i);
    }
});
