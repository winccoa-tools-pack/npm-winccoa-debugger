import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
    WinCCDebugSession,
    AttachRequestArguments,
} from '../../src/adapter/WinCCDebugSession';
import { DatapointClient, DatapointConfig } from '../../src/connection/DatapointClient';
import { DebugProtocol } from '@vscode/debugprotocol';

// ---------------------------------------------------------------------------
// MockDatapointClient
// ---------------------------------------------------------------------------

class MockDatapointClient extends EventEmitter {
    public connected = false;
    /** Next sendCommand call will reject with this error (one-shot). */
    public nextCommandError: Error | null = null;
    /** Return value for the next sendCommand call (one-shot). */
    public nextCommandResult: string[] = ['OK'];
    /** Every sendCommand call recorded here. */
    public commands: string[] = [];

    private readonly dp: string;

    constructor(config: DatapointConfig) {
        super();
        const prefix = config.managerType ?? 'CTRL';
        this.dp = `_CtrlDebug_${prefix}_${config.managerNumber}`;
    }

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

    getDebugDp(): string {
        return this.dp;
    }

    async sendCommand(cmd: string): Promise<string[]> {
        this.commands.push(cmd);
        if (this.nextCommandError) {
            const err = this.nextCommandError;
            this.nextCommandError = null;
            throw err;
        }
        const result = this.nextCommandResult;
        this.nextCommandResult = ['OK'];
        return result;
    }
}

// ---------------------------------------------------------------------------
// TestWinCCDebugSession
// Intercepts sendResponse / sendEvent so we can inspect them without a
// running DAP server stream.
// ---------------------------------------------------------------------------

class TestWinCCDebugSession extends WinCCDebugSession {
    public sentResponses: DebugProtocol.Response[] = [];
    public sentEvents: DebugProtocol.Event[] = [];
    public mockClient: MockDatapointClient | null = null;

    constructor(mockClient?: MockDatapointClient) {
        super();
        this.mockClient = mockClient ?? null;
    }

    protected override createDatapointClient(config: DatapointConfig): DatapointClient {
        if (this.mockClient) {
            return this.mockClient as unknown as DatapointClient;
        }
        return new MockDatapointClient(config) as unknown as DatapointClient;
    }

    override sendResponse(response: DebugProtocol.Response): void {
        this.sentResponses.push(JSON.parse(JSON.stringify(response)));
    }

    override sendEvent(event: DebugProtocol.Event): void {
        this.sentEvents.push(JSON.parse(JSON.stringify(event)));
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(mockClient?: MockDatapointClient): TestWinCCDebugSession {
    return new TestWinCCDebugSession(mockClient);
}

/** Minimal attach args – only required fields. */
const defaultAttachArgs: AttachRequestArguments = {
    system: 'System1',
    host: 'localhost',
    port: 4999,
    manager: { type: 'CTRL', number: 1 },
};

function makeResponse<T extends DebugProtocol.Response>(
    command: string,
): T {
    return {
        seq: 1,
        type: 'response',
        request_seq: 1,
        success: true,
        command,
        body: {},
    } as unknown as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('WinCCDebugSession: initializeRequest responds with capabilities', () => {
    const session = makeSession();
    const response = makeResponse<DebugProtocol.InitializeResponse>('initialize');
    const args: DebugProtocol.InitializeRequestArguments = {
        clientID: 'vscode',
        adapterID: 'winccoa',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
    };

    session.initializeRequest(response, args);

    assert.equal(session.sentResponses.length, 1);
    const body = session.sentResponses[0].body as DebugProtocol.Capabilities;
    assert.equal(body.supportsConfigurationDoneRequest, true);
    assert.equal(body.supportsEvaluateForHovers, true);
    assert.equal(body.supportsTerminateRequest, true);
    assert.equal(body.supportTerminateDebuggee, true);
    // No InitializedEvent in initializeRequest — sent after attach/connect
    assert.equal(session.sentEvents.length, 0);
});

test('WinCCDebugSession: attachRequest connects and sends InitializedEvent', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    const response = makeResponse<DebugProtocol.AttachResponse>('attach');

    session.attachRequest(response, defaultAttachArgs);

    // attachRequest is async under the hood; wait a tick
    await new Promise((r) => setImmediate(r));

    assert.equal(session.sentResponses.length, 1, 'Should send exactly one response');
    assert.equal(session.sentResponses[0].success, true);
    // InitializedEvent must be sent AFTER the successful response
    const initEvent = session.sentEvents.find((e) => e.event === 'initialized');
    assert.ok(initEvent, 'InitializedEvent must be emitted after successful connect');
});

test('WinCCDebugSession: attachRequest sends error response when connect fails', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    mock.connect = async () => {
        throw new Error('Connection refused');
    };
    const session = makeSession(mock);
    const response = makeResponse<DebugProtocol.AttachResponse>('attach');

    session.attachRequest(response, defaultAttachArgs);
    await new Promise((r) => setImmediate(r));

    assert.equal(session.sentResponses.length, 1);
    assert.equal(session.sentResponses[0].success, false);
    assert.match(session.sentResponses[0].message ?? '', /Connection refused/);
    assert.equal(session.sentEvents.length, 0, 'No InitializedEvent on failure');
});

test('WinCCDebugSession: setBreakPointsRequest returns unverified when not connected', () => {
    const session = makeSession();
    const response = makeResponse<DebugProtocol.SetBreakpointsResponse>('setBreakpoints');
    const args: DebugProtocol.SetBreakpointsArguments = {
        source: { path: '/proj/scripts/test.ctl' },
        breakpoints: [{ line: 5 }, { line: 12 }],
    };

    session.setBreakPointsRequest(response, args);

    assert.equal(session.sentResponses.length, 1);
    const bps = (session.sentResponses[0].body as DebugProtocol.SetBreakpointsResponse['body'])
        .breakpoints;
    assert.equal(bps.length, 2);
    assert.equal(bps[0].verified, false);
    assert.equal(bps[1].verified, false);
    assert.equal(bps[0].line, 5);
    assert.equal(bps[1].line, 12);
});

test('WinCCDebugSession: setBreakPointsRequest sets breakpoints when connected', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();

    // Inject the client into the session (simulate successful attach)
    (session as any).client = mock;

    // clear returns OK, break returns Breakpoint confirmed
    const results = [['OK'], ['OK', 'Breakpoint set at line 5'], ['OK', 'Breakpoint set at line 12']];
    let callIdx = 0;
    mock.sendCommand = async (cmd: string) => {
        mock.commands.push(cmd);
        return results[callIdx++] ?? ['OK'];
    };

    const response = makeResponse<DebugProtocol.SetBreakpointsResponse>('setBreakpoints');
    const args: DebugProtocol.SetBreakpointsArguments = {
        source: { path: 'scripts/test.ctl' },
        breakpoints: [{ line: 5 }, { line: 12 }],
    };

    session.setBreakPointsRequest(response, args);
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands[0].startsWith('clear '), 'Should clear file first');
    assert.ok(mock.commands[1].includes(':5'), 'Should set bp at line 5');
    assert.ok(mock.commands[2].includes(':12'), 'Should set bp at line 12');

    const bps = (session.sentResponses[0].body as DebugProtocol.SetBreakpointsResponse['body'])
        .breakpoints;
    assert.equal(bps[0].verified, true);
    assert.equal(bps[1].verified, true);
});

test('WinCCDebugSession: continueRequest sends "continue" command', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    const response = makeResponse<DebugProtocol.ContinueResponse>('continue');
    session.continueRequest(response, { threadId: 1 });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('continue'));
    assert.equal(session.sentResponses.length, 1);
    assert.equal(
        (session.sentResponses[0].body as DebugProtocol.ContinueResponse['body'])
            .allThreadsContinued,
        true,
    );
});

test('WinCCDebugSession: nextRequest sends "next" command', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    const response = makeResponse<DebugProtocol.NextResponse>('next');
    session.nextRequest(response, { threadId: 1, granularity: 'statement' });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('next'));
    assert.equal(session.sentResponses.length, 1);
});

test('WinCCDebugSession: stepInRequest sends "step" command', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    const response = makeResponse<DebugProtocol.StepInResponse>('stepIn');
    session.stepInRequest(response, { threadId: 1, granularity: 'statement' });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('step'));
    assert.equal(session.sentResponses.length, 1);
});

test('WinCCDebugSession: stepOutRequest sends "finish" command', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    const response = makeResponse<DebugProtocol.StepOutResponse>('stepOut');
    session.stepOutRequest(response, { threadId: 1, granularity: 'statement' });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('finish'));
    assert.equal(session.sentResponses.length, 1);
});

test('WinCCDebugSession: pauseRequest sends "interrupt" command', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    const response = makeResponse<DebugProtocol.PauseResponse>('pause');
    session.pauseRequest(response, { threadId: 1 });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('interrupt'));
    assert.equal(session.sentResponses.length, 1);
});

test('WinCCDebugSession: threadsRequest returns default thread when not connected', async () => {
    const session = makeSession();
    const response = makeResponse<DebugProtocol.ThreadsResponse>('threads');

    session.threadsRequest(response);
    await new Promise((r) => setImmediate(r));

    assert.equal(session.sentResponses.length, 1);
    const threads = (session.sentResponses[0].body as DebugProtocol.ThreadsResponse['body'])
        .threads;
    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, 1);
    assert.equal(threads[0].name, 'CTRL Manager');
});

test('WinCCDebugSession: threadsRequest parses GDB-style "info threads" response', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.nextCommandResult = [
        '* 1  Thread main',
        '  2  Thread worker',
    ];

    const response = makeResponse<DebugProtocol.ThreadsResponse>('threads');
    session.threadsRequest(response);
    await new Promise((r) => setImmediate(r));

    const threads = (session.sentResponses[0].body as DebugProtocol.ThreadsResponse['body'])
        .threads;
    assert.equal(threads.length, 2);
    assert.equal(threads[0].id, 1);
    assert.equal(threads[0].name, 'main');
    assert.equal(threads[1].id, 2);
    assert.equal(threads[1].name, 'worker');
});

test('WinCCDebugSession: stackTraceRequest parses GDB-style "bt" response', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.nextCommandResult = [
        '#0  testFunction () at scripts/debugTest.ctl:29',
        '#1  main () at scripts/debugTest.ctl:5',
    ];

    const response = makeResponse<DebugProtocol.StackTraceResponse>('stackTrace');
    session.stackTraceRequest(response, { threadId: 1 });
    await new Promise((r) => setImmediate(r));

    const body = session.sentResponses[0].body as DebugProtocol.StackTraceResponse['body'];
    assert.equal(body.stackFrames.length, 2);
    assert.equal(body.stackFrames[0].id, 0);
    assert.equal(body.stackFrames[0].name, 'testFunction');
    assert.equal(body.stackFrames[0].line, 29);
    assert.equal(body.stackFrames[0].source?.name, 'debugTest.ctl');
    assert.equal(body.stackFrames[1].id, 1);
    assert.equal(body.stackFrames[1].name, 'main');
    assert.equal(body.stackFrames[1].line, 5);
});

test('WinCCDebugSession: stackTraceRequest returns empty frames when not connected', async () => {
    const session = makeSession();
    const response = makeResponse<DebugProtocol.StackTraceResponse>('stackTrace');

    session.stackTraceRequest(response, { threadId: 1 });
    await new Promise((r) => setImmediate(r));

    const body = session.sentResponses[0].body as DebugProtocol.StackTraceResponse['body'];
    assert.equal(body.stackFrames.length, 0);
    assert.equal(body.totalFrames, 0);
});

test('WinCCDebugSession: scopesRequest returns Locals scope with variablesReference', () => {
    const session = makeSession();
    const response = makeResponse<DebugProtocol.ScopesResponse>('scopes');

    session.scopesRequest(response, { frameId: 0 });

    const scopes = (session.sentResponses[0].body as DebugProtocol.ScopesResponse['body'])
        .scopes;
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0].name, 'Locals');
    assert.ok(scopes[0].variablesReference > 0, 'variablesReference must be non-zero');
    assert.equal(scopes[0].expensive, false);
});

test('WinCCDebugSession: variablesRequest sends "info locals" and parses result', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.nextCommandResult = ['i = 5', 'result = 120'];

    // First get a valid variablesReference via scopesRequest
    const scopesResp = makeResponse<DebugProtocol.ScopesResponse>('scopes');
    session.scopesRequest(scopesResp, { frameId: 0 });
    const varRef = (session.sentResponses[0].body as DebugProtocol.ScopesResponse['body'])
        .scopes[0].variablesReference;
    session.sentResponses = [];

    const response = makeResponse<DebugProtocol.VariablesResponse>('variables');
    session.variablesRequest(response, { variablesReference: varRef });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('info locals'));
    const vars = (session.sentResponses[0].body as DebugProtocol.VariablesResponse['body'])
        .variables;
    assert.equal(vars.length, 2);
    assert.equal(vars[0].name, 'i');
    assert.equal(vars[0].value, '5');
    assert.equal(vars[1].name, 'result');
    assert.equal(vars[1].value, '120');
});

test('WinCCDebugSession: variablesRequest returns empty when not connected', () => {
    const session = makeSession();
    const response = makeResponse<DebugProtocol.VariablesResponse>('variables');

    session.variablesRequest(response, { variablesReference: 9999 });

    const vars = (session.sentResponses[0].body as DebugProtocol.VariablesResponse['body'])
        .variables;
    assert.equal(vars.length, 0);
});

test('WinCCDebugSession: evaluateRequest sends "print <expr>" and returns value', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.nextCommandResult = ['OK', '42'];

    const response = makeResponse<DebugProtocol.EvaluateResponse>('evaluate');
    session.evaluateRequest(response, { expression: 'myVar', context: 'hover', frameId: 0 });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('print myVar'));
    const body = session.sentResponses[0].body as DebugProtocol.EvaluateResponse['body'];
    assert.equal(body.result, '42');
    assert.equal(body.variablesReference, 0);
});

test('WinCCDebugSession: evaluateRequest returns error when not connected', () => {
    const session = makeSession();
    const response = makeResponse<DebugProtocol.EvaluateResponse>('evaluate');

    session.evaluateRequest(response, { expression: 'myVar', context: 'hover', frameId: 0 });

    assert.equal(session.sentResponses.length, 1);
    assert.equal(session.sentResponses[0].success, false);
    assert.match(session.sentResponses[0].message ?? '', /not connected/i);
});

test('WinCCDebugSession: disconnectRequest calls client.disconnect()', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    let disconnected = false;
    mock.disconnect = async () => {
        disconnected = true;
        mock.connected = false;
        mock.emit('disconnected');
    };

    const response = makeResponse<DebugProtocol.DisconnectResponse>('disconnect');
    session.disconnectRequest(response, { restart: false });
    await new Promise((r) => setImmediate(r));

    assert.ok(disconnected, 'DatapointClient.disconnect() must be called');
    assert.equal(session.sentResponses.length, 1);
});

test('WinCCDebugSession: terminateRequest disconnects and sends TerminatedEvent', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    const response = makeResponse<DebugProtocol.TerminateResponse>('terminate');
    session.terminateRequest(response, { restart: false });
    await new Promise((r) => setImmediate(r));

    assert.equal(session.sentResponses.length, 1);
    const terminated = session.sentEvents.find((e) => e.event === 'terminated');
    assert.ok(terminated, 'TerminatedEvent must be emitted on terminate');
});

test('WinCCDebugSession: unsolicited "stopped" message emits StoppedEvent', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    // Simulate attach to register the 'message' listener
    const attachResp = makeResponse<DebugProtocol.AttachResponse>('attach');
    session.attachRequest(attachResp, defaultAttachArgs);
    await new Promise((r) => setImmediate(r));
    session.sentEvents = []; // clear InitializedEvent

    // Simulate unsolicited stop message from WinCC OA
    mock.emit('message', ['stopped', 'breakpoint', '1']);
    await new Promise((r) => setImmediate(r));

    const stopEvent = session.sentEvents.find((e) => e.event === 'stopped');
    assert.ok(stopEvent, 'StoppedEvent must be emitted on unsolicited stop message');
    assert.equal((stopEvent as DebugProtocol.StoppedEvent).body.reason, 'breakpoint');
    assert.equal((stopEvent as DebugProtocol.StoppedEvent).body.threadId, 1);
});

test('WinCCDebugSession: "disconnected" event from client emits TerminatedEvent', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();

    const attachResp = makeResponse<DebugProtocol.AttachResponse>('attach');
    session.attachRequest(attachResp, defaultAttachArgs);
    await new Promise((r) => setImmediate(r));
    session.sentEvents = [];

    mock.emit('disconnected');
    await new Promise((r) => setImmediate(r));

    const terminated = session.sentEvents.find((e) => e.event === 'terminated');
    assert.ok(terminated, 'TerminatedEvent must be emitted when client disconnects unexpectedly');
});

test('WinCCDebugSession: path mappings applied when setting breakpoints', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;
    (session as any).pathMappings = { '/home/dev/project/': 'scripts/' };

    let clearedPath = '';
    let breakPath = '';
    mock.sendCommand = async (cmd: string) => {
        mock.commands.push(cmd);
        if (cmd.startsWith('clear ')) clearedPath = cmd.slice(6);
        if (cmd.startsWith('break ')) breakPath = cmd;
        return ['OK'];
    };

    const response = makeResponse<DebugProtocol.SetBreakpointsResponse>('setBreakpoints');
    session.setBreakPointsRequest(response, {
        source: { path: '/home/dev/project/debugTest.ctl' },
        breakpoints: [{ line: 10 }],
    });
    await new Promise((r) => setImmediate(r));

    assert.equal(clearedPath, 'scripts/debugTest.ctl');
    assert.ok(breakPath.includes('scripts/debugTest.ctl:10'));
});

test('WinCCDebugSession: launchRequest behaves like attachRequest', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    const response = makeResponse<DebugProtocol.LaunchResponse>('launch');

    session.launchRequest(response, { ...defaultAttachArgs, noDebug: false });
    await new Promise((r) => setImmediate(r));

    assert.equal(session.sentResponses[0].success, true);
    assert.ok(session.sentEvents.some((e) => e.event === 'initialized'));
});
