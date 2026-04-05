import test from 'node:test';
import assert from 'node:assert/strict';
import { DatapointClient, DatapointConfig, IWinccoaManager } from '../../src/connection/DatapointClient';

// ---------------------------------------------------------------------------
// Mock WinccoaManager (stand-in for official winccoa-manager package)
// Implements the IWinccoaManager interface with correct API signatures.
// ---------------------------------------------------------------------------
class MockWinccoaManager implements IWinccoaManager {
    public writtenValues = new Map<string, any>();
    /** subscription id → { callback, dpeNames, answer } */
    private subscriptions = new Map<number, { callback: (values: any[], dpeNames: string[]) => void; dpeNames: string | string[]; answer: boolean }>();
    private nextSubId = 1;
    /** Track the `answer` flag passed to the most recent dpConnect call */
    public lastDpConnectAnswer: boolean | undefined = undefined;

    /** Official API: callback is FIRST param, returns subscription id */
    dpConnect(callback: (names: string[], values: any[], type?: any, error?: any) => void, dpeNames: string | string[], answer?: boolean): number {
        const id = this.nextSubId++;
        this.lastDpConnectAnswer = answer ?? false;
        this.subscriptions.set(id, { callback, dpeNames, answer: answer ?? false });
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
                // Real WinccoaManager callback: (names: string[], values: any[])
                // names[0] = DPE name, values[0] = actual DPE value
                callback([dpName], [value]);
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
    // DPEs use flat structure with system prefix: System1:_CtrlDebug_CTRL_1.Result
    const resultDpe = 'System1:_CtrlDebug_CTRL_1.Result';
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
    // DPEs use flat structure with system prefix: System1:_CtrlDebug_CTRL_1.Command
    setTimeout(() => {
        const raw = api.writtenValues.get('System1:_CtrlDebug_CTRL_1.Command');
        assert.ok(raw, 'Command DPE should have been written');
        const cmd = JSON.parse(raw);
        assert.ok(cmd.id, 'Command must have an id');
        assert.equal(cmd.cmd, 'break scripts/debugTest.ctl 10');
        // Simulate WinCC OA response
        api.simulateValue('System1:_CtrlDebug_CTRL_1.Result', [cmd.id, 'OK', 'Breakpoint set at line 10']);
    }, 10);

    const result = await client.sendCommand('break scripts/debugTest.ctl 10');
    assert.deepEqual(result, ['OK', 'Breakpoint set at line 10']);
});

test('DatapointClient: sendCommand returns parsed response array', async () => {
    const { client, api } = makeConnectedClient();
    await client.connect();

    setTimeout(() => {
        const raw = api.writtenValues.get('System1:_CtrlDebug_CTRL_1.Command');
        const cmd = JSON.parse(raw);
        api.simulateValue('System1:_CtrlDebug_CTRL_1.Result', [cmd.id, 'thread1', 'thread2', 'thread3']);
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

test('DatapointClient: uses system prefix in DPE names when system is set', async () => {
    const { client, api } = makeConnectedClient({ system: 'System1' });
    await client.connect();

    setTimeout(() => {
        const raw = api.writtenValues.get('System1:_CtrlDebug_CTRL_1.Command');
        assert.ok(raw, 'DPE should be written with system prefix');
        const cmd = JSON.parse(raw);
        api.simulateValue('System1:_CtrlDebug_CTRL_1.Result', [cmd.id, 'OK']);
    }, 10);

    const result = await client.sendCommand('test');
    assert.deepEqual(result, ['OK']);
});

test('DatapointClient: omits system prefix in DPE names when system is not set', async () => {
    const { client, api } = makeConnectedClient({ system: undefined });
    await client.connect();

    setTimeout(() => {
        const raw = api.writtenValues.get('_CtrlDebug_CTRL_1.Command');
        assert.ok(raw, 'DPE should be written without system prefix');
        const cmd = JSON.parse(raw);
        api.simulateValue('_CtrlDebug_CTRL_1.Result', [cmd.id, 'OK']);
    }, 10);

    const result = await client.sendCommand('test');
    assert.deepEqual(result, ['OK']);
});

test('DatapointClient: ID-quirk — stop event with command ID emits message AND resolves command', async () => {
    // WinCC OA 3.21 attaches the last command's ID to stop events (e.g. during "b" pause).
    // When WinCC OA responds to command "b" with a stop event:
    //   ["<cmd-id>", "line: 26", "/path/file.ctl", "ScriptId: 0", "ScopeId: 0", "ThreadId: 0 (stopped) main"]
    // DatapointClient must:
    //   1. Resolve the pending "b" command (so caller doesn't hang)
    //   2. Emit 'message' with result (WITHOUT the UUID prefix) so the session
    //      can detect msg[0] = "line: N" and fire a StoppedEvent.
    const { client, api } = makeConnectedClient();
    await client.connect();

    let emittedMsg: string[] | null = null;
    client.on('message', (msg: string[]) => {
        emittedMsg = msg;
    });

    // Simulate: sendCommand('b') is pending, then WinCC OA responds with a stop event
    // that happens to carry the command's ID as its first element.
    setTimeout(() => {
        const raw = api.writtenValues.get('System1:_CtrlDebug_CTRL_1.Command');
        assert.ok(raw, 'Command DPE must be written');
        const cmd = JSON.parse(raw) as { id: string; cmd: string };
        assert.equal(cmd.cmd, 'b');

        // WinCC OA 3.21 format: ID-prefixed stop event
        api.simulateValue('System1:_CtrlDebug_CTRL_1.Result', [
            cmd.id,
            'line: 26',
            '/path/loop_test.ctl',
            'ScriptId: 0',
            'ScopeId: 0',
            'ThreadId: 0 (stopped) main',
        ]);
    }, 10);

    // The command should resolve (not hang) even though it's a stop event response.
    const result = await client.sendCommand('b');

    // The resolved result is the stop data (without the UUID prefix).
    assert.deepEqual(result, [
        'line: 26',
        '/path/loop_test.ctl',
        'ScriptId: 0',
        'ScopeId: 0',
        'ThreadId: 0 (stopped) main',
    ]);

    // 'message' must have been emitted WITH the stop data (no UUID prefix)
    // so that WinCCDebugSession.handleUnsolicitedMessage can process msg[0] = "line: N".
    assert.ok(emittedMsg, "'message' event must be emitted for the stop event");
    assert.equal(emittedMsg![0], 'line: 26', 'msg[0] must be "line: N" (no UUID prefix)');
    assert.equal(emittedMsg![2], 'ScriptId: 0');
    assert.equal(emittedMsg![4], 'ThreadId: 0 (stopped) main');
});

test('DatapointClient: answerOnConnect=false passes answer=false to dpConnect', async () => {
    const { client, api } = makeConnectedClient({ answerOnConnect: false });
    await client.connect();
    assert.equal(api.lastDpConnectAnswer, false, 'answer=false should be forwarded to dpConnect');
});

test('DatapointClient: answerOnConnect=true passes answer=true to dpConnect', async () => {
    // answerOnConnect=true is required for stopOnEntry / DebugBreak():
    // the script may have already hit DebugBreak() before the adapter connected,
    // so we need the current (stale) Result DPE value delivered on connect.
    const { client, api } = makeConnectedClient({ answerOnConnect: true });
    await client.connect();
    assert.equal(api.lastDpConnectAnswer, true, 'answer=true should be forwarded to dpConnect');
});

test('DatapointClient: answerOnConnect emits message from current DPE value on connect', async () => {
    // When answer=true, dpConnect may fire IMMEDIATELY with the current DPE value.
    // Simulate this by having the mock call the callback synchronously inside dpConnect
    // (like WinCC OA does when answer=true and the DPE already has a value).
    class ImmediateAnswerMock extends MockWinccoaManager {
        override dpConnect(
            callback: (names: string[], values: any[], type?: any, error?: any) => void,
            dpeNames: string | string[],
            answer?: boolean,
        ): number {
            const id = super.dpConnect(callback, dpeNames, answer);
            if (answer) {
                // Fire immediately: script was already stopped at DebugBreak() before connect
                const dpName = Array.isArray(dpeNames) ? dpeNames[0] : dpeNames;
                callback(
                    [dpName as string],
                    [
                        [
                            'line: 21',
                            '/proj/scripts/stop_on_entry.ctl',
                            'ScriptId: 3',
                            'ScopeId: 0',
                            'ThreadId: 1 (stopped) main',
                        ],
                    ],
                );
            }
            return id;
        }
    }

    const config: DatapointConfig = {
        host: 'localhost',
        port: 4999,
        system: 'System1',
        managerType: 'CTRL',
        managerNumber: 3,
        answerOnConnect: true,
    };
    const api = new ImmediateAnswerMock();
    const client = new DatapointClient(config, api);

    const messages: string[][] = [];
    client.on('message', (msg: string[]) => messages.push(msg));

    await client.connect();

    // Allow microtasks/nextTick to flush
    await new Promise((r) => setImmediate(r));

    assert.ok(messages.length > 0, 'message event should fire on connect with answerOnConnect=true');
    assert.match(messages[0]![0] ?? '', /^line:\s+21/, 'First message should be the pre-connect stop event');
    assert.ok(
        messages[0]!.some((s) => /ScriptId:\s*3/i.test(s)),
        `Expected ScriptId: 3 in first message, got: ${JSON.stringify(messages[0])}`,
    );
});
