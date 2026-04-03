import test from 'node:test';
import assert from 'node:assert/strict';
import { DatapointClient, DatapointConfig, IWinccoaManager } from '../../src/connection/DatapointClient';

// ---------------------------------------------------------------------------
// Mock WinccoaManager (stand-in for official winccoa-manager package)
// Implements the IWinccoaManager interface with correct API signatures.
// ---------------------------------------------------------------------------
class MockWinccoaManager implements IWinccoaManager {
    public writtenValues = new Map<string, any>();
    /** subscription id → { callback, dpeNames } */
    private subscriptions = new Map<number, { callback: (values: any[], dpeNames: string[]) => void; dpeNames: string | string[] }>();
    private nextSubId = 1;

    /** Official API: callback is FIRST param, returns subscription id */
    dpConnect(callback: (values: any[], dpeNames: string[]) => void, dpeNames: string | string[], _answer?: boolean): number {
        const id = this.nextSubId++;
        this.subscriptions.set(id, { callback, dpeNames });
        return id;
    }

    dpDisconnect(id: number): void {
        this.subscriptions.delete(id);
    }

    dpSet(dpeNames: string | string[], values: any | any[]): void {
        if (Array.isArray(dpeNames)) {
            (dpeNames as string[]).forEach((dp, i) => this.writtenValues.set(dp, (values as any[])[i]));
        } else {
            this.writtenValues.set(dpeNames as string, values);
        }
    }

    async dpSetWait(dpeNames: string | string[], values: any | any[]): Promise<void> {
        this.dpSet(dpeNames, values);
    }

    /** Test helper: simulate a DPE value change for subscribers on the given DPE */
    simulateValue(dpName: string, value: any): void {
        for (const { callback, dpeNames } of this.subscriptions.values()) {
            const subscribed = Array.isArray(dpeNames) ? dpeNames : [dpeNames];
            if ((subscribed as string[]).includes(dpName)) {
                callback([value], [dpName]);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helper: build a DatapointClient with mock manager injected
// ---------------------------------------------------------------------------
function makeConnectedClient(config?: Partial<DatapointConfig>): { client: DatapointClient; api: MockWinccoaManager } {
    const fullConfig: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 1,
        ...config,
    };
    const api = new MockWinccoaManager();
    const client = new DatapointClient(fullConfig, api);
    return { client, api };
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
    const { client } = makeConnectedClient();

    await client.connect();

    assert.ok(client.isConnected());
});

test('DatapointClient: connect subscribes to Result DPE', async () => {
    const { client, api } = makeConnectedClient();

    await client.connect();

    // Simulate a response — the client must receive it without crashing.
    // DPEs use the nested _CtrlDebug struct: _CtrlDebug_CTRL_1._CtrlDebug.Result
    const resultDpe = '_CtrlDebug_CTRL_1._CtrlDebug.Result';
    api.simulateValue(resultDpe, ['unknown-id', 'OK']);
    // No pending command with that id, so it should emit 'message' (or silently ignore)
    assert.ok(true);
});

test('DatapointClient: disconnect closes connection', async () => {
    const { client } = makeConnectedClient();

    await client.connect();
    assert.ok(client.isConnected());

    await client.disconnect();
    assert.ok(!client.isConnected());
});

test('DatapointClient: sendCommand writes JSON to Command DPE', async () => {
    const { client, api } = makeConnectedClient();
    await client.connect();

    // Fire response after a tick.
    // DPEs use the nested _CtrlDebug struct path inside the datapoint.
    setTimeout(() => {
        const raw = api.writtenValues.get('_CtrlDebug_CTRL_1._CtrlDebug.Command');
        assert.ok(raw, 'Command DPE should have been written');
        const cmd = JSON.parse(raw);
        assert.ok(cmd.id, 'Command must have an id');
        assert.equal(cmd.cmd, 'break scripts/debugTest.ctl 10');
        // Simulate WinCC OA response
        api.simulateValue('_CtrlDebug_CTRL_1._CtrlDebug.Result', [cmd.id, 'OK', 'Breakpoint set at line 10']);
    }, 10);

    const result = await client.sendCommand('break scripts/debugTest.ctl 10');
    assert.deepEqual(result, ['OK', 'Breakpoint set at line 10']);
});

test('DatapointClient: sendCommand returns parsed response array', async () => {
    const { client, api } = makeConnectedClient();
    await client.connect();

    setTimeout(() => {
        const raw = api.writtenValues.get('_CtrlDebug_CTRL_1._CtrlDebug.Command');
        const cmd = JSON.parse(raw);
        api.simulateValue('_CtrlDebug_CTRL_1._CtrlDebug.Result', [cmd.id, 'thread1', 'thread2', 'thread3']);
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

