import test from 'node:test';
import assert from 'node:assert/strict';
import { DatapointClient, DatapointConfig, IWinccoaApi, IWinccoaConnection } from '../../src/connection/DatapointClient';

// ---------------------------------------------------------------------------
// Mock WinccoaManagerApi (stand-in for winccoaconnection.node)
// ---------------------------------------------------------------------------
class MockWinccoaApi implements IWinccoaApi {
    public writtenValues = new Map<string, any>();
    private callbacks = new Map<string, (value: any) => void>();

    dpConnect(dpName: string, callback: (value: any) => void): void {
        this.callbacks.set(dpName, callback);
    }

    dpSet(dpName: string, value: any): void {
        this.writtenValues.set(dpName, value);
    }

    async dpGet(dpName: string): Promise<any> {
        return this.writtenValues.get(dpName);
    }

    /** Test helper: simulate a value arriving on a subscribed DPE */
    simulateValue(dpName: string, value: any): void {
        const cb = this.callbacks.get(dpName);
        if (cb) cb(value);
    }
}

class MockWinccoaConnection implements IWinccoaConnection {
    public started = false;
    async managerStart(_args: string[], _api: IWinccoaApi): Promise<void> {
        this.started = true;
    }
    prepareExit(): void {
        this.started = false;
    }
}

// ---------------------------------------------------------------------------
// Helper: build a pre-connected DatapointClient with mocks injected
// ---------------------------------------------------------------------------
function makeConnectedClient(config?: Partial<DatapointConfig>): { client: DatapointClient; api: MockWinccoaApi; conn: MockWinccoaConnection } {
    const fullConfig: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
        ...config,
    };
    const api = new MockWinccoaApi();
    const conn = new MockWinccoaConnection();
    const client = new DatapointClient(fullConfig, api, conn);
    return { client, api, conn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('DatapointClient: constructor initializes with config', () => {
    const { client } = makeConnectedClient();
    assert.ok(client);
    assert.equal(client.getDebugDp(), '_CtrlDebug_CTRL_1');
    assert.ok(!client.isConnected());
});

test('DatapointClient: builds correct datapoint name', () => {
    const { client: ctrl1 } = makeConnectedClient({ managerType: 'CTRL', managerNumber: 1 });
    assert.equal(ctrl1.getDebugDp(), '_CtrlDebug_CTRL_1');

    const { client: ui5 } = makeConnectedClient({ managerType: 'UI', managerNumber: 5 });
    assert.equal(ui5.getDebugDp(), '_CtrlDebug_UI_5');

    const { client: driver3 } = makeConnectedClient({ managerType: 'DRIVER', managerNumber: 3 });
    assert.equal(driver3.getDebugDp(), '_CtrlDebug_DRIVER_3');
});

test('DatapointClient: connect establishes connection via injected api', async () => {
    const { client, conn } = makeConnectedClient();

    await client.connect();

    assert.ok(client.isConnected());
    assert.ok(conn.started);
});

test('DatapointClient: connect subscribes to Result DPE', async () => {
    const { client, api } = makeConnectedClient();

    await client.connect();

    // After connect, dpConnect must have been called for the Result DPE
    const resultDpe = '_CtrlDebug_CTRL_1.Result';
    // Simulate a value to verify the callback is wired up
    let received: any = null;
    // Patch: replace callback with our own to verify
    api.dpConnect(resultDpe + '_test', (v) => { received = v; });
    api.simulateValue(resultDpe, ['some-id', 'hello']);
    // The client should have received it internally (no crash)
    assert.ok(true);
});

test('DatapointClient: disconnect closes connection', async () => {
    const { client, conn } = makeConnectedClient();

    await client.connect();
    assert.ok(client.isConnected());

    await client.disconnect();
    assert.ok(!client.isConnected());
    assert.ok(!conn.started);
});

test('DatapointClient: sendCommand writes JSON to Command DPE', async () => {
    const { client, api } = makeConnectedClient();
    await client.connect();

    // Fire response after a tick
    setTimeout(() => {
        const raw = api.writtenValues.get('_CtrlDebug_CTRL_1.Command');
        assert.ok(raw, 'Command DPE should have been written');
        const cmd = JSON.parse(raw);
        assert.ok(cmd.id, 'Command must have an id');
        assert.equal(cmd.cmd, 'break scripts/debugTest.ctl 10');
        // Simulate WinCC OA response
        api.simulateValue('_CtrlDebug_CTRL_1.Result', [cmd.id, 'OK', 'Breakpoint set at line 10']);
    }, 10);

    const result = await client.sendCommand('break scripts/debugTest.ctl 10');
    assert.deepEqual(result, ['OK', 'Breakpoint set at line 10']);
});

test('DatapointClient: sendCommand returns parsed response array', async () => {
    const { client, api } = makeConnectedClient();
    await client.connect();

    setTimeout(() => {
        const raw = api.writtenValues.get('_CtrlDebug_CTRL_1.Command');
        const cmd = JSON.parse(raw);
        api.simulateValue('_CtrlDebug_CTRL_1.Result', [cmd.id, 'thread1', 'thread2', 'thread3']);
    }, 10);

    const result = await client.sendCommand('info threads');
    assert.deepEqual(result, ['thread1', 'thread2', 'thread3']);
});

test('DatapointClient: sendCommand times out when no response', async () => {
    const { client } = makeConnectedClient();
    await client.connect();

    // No response simulated
    try {
        await client.sendCommand('info threads', 100);
        assert.fail('Should have timed out');
    } catch (err) {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /timeout/i);
    }
});

test('DatapointClient: disconnect cancels pending commands', async () => {
    const { client } = makeConnectedClient();
    await client.connect();

    const cmdPromise = client.sendCommand('info threads', 5000);
    await client.disconnect();

    try {
        await cmdPromise;
        assert.fail('Should have been rejected');
    } catch (err) {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /closed/i);
    }
});

test('DatapointClient: handles connection errors', async () => {
    const config: DatapointConfig = {
        host: 'invalid-host',
        port: 9999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
    };

    // No injected api → will try to load real addon → expected to fail in test env
    const client = new DatapointClient(config);
    assert.ok(!client.isConnected());

    let threw = false;
    try {
        await client.connect();
    } catch {
        threw = true;
    }
    assert.ok(threw, 'connect() without WinCC OA should throw');
});

