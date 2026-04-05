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
    // cont + delete-all must be sent before InitializedEvent to resume any
    // stale paused state and clear old breakpoints from the previous session.
    assert.ok(mock.commands.includes('cont'), 'attach must send cont to resume stale paused state');
    assert.ok(mock.commands.includes('delete-all'), 'attach must send delete-all to clear stale BPs');
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

    // info scripts returns one entry; breakpoint commands return success
    const results: Record<string, string[]> = {};
    mock.sendCommand = async (cmd: string) => {
        mock.commands.push(cmd);
        if (cmd === 'info scripts') {
            return ['ScriptId: 7; current thread: 0; scripts/test.ctl'];
        }
        if (cmd.startsWith('breakpoint ')) {
            return ['breakpoint set'];
        }
        return ['OK'];
    };
    void results; // suppress unused warning

    const response = makeResponse<DebugProtocol.SetBreakpointsResponse>('setBreakpoints');
    const args: DebugProtocol.SetBreakpointsArguments = {
        source: { path: 'scripts/test.ctl' },
        breakpoints: [{ line: 5 }, { line: 12 }],
    };

    session.setBreakPointsRequest(response, args);
    await new Promise((r) => setImmediate(r));

    assert.equal(mock.commands[0], 'info scripts', 'First command must be info scripts');
    assert.ok(mock.commands[1].startsWith('breakpoint '), 'Second command must be breakpoint');
    assert.ok(mock.commands[2].startsWith('breakpoint '), 'Third command must be breakpoint');

    const bp1 = JSON.parse(mock.commands[1].slice('breakpoint '.length));
    assert.equal(bp1.scriptId, 7, 'scriptId must be 7');
    assert.equal(bp1.line, 5, 'line must be 5');
    assert.equal(bp1.scopeId, 0, 'scopeId must be 0 (required by WinCC OA 3.21)');
    assert.equal(bp1.lib, -1, 'lib must be -1 (required by WinCC OA 3.21)');

    const bp2 = JSON.parse(mock.commands[2].slice('breakpoint '.length));
    assert.equal(bp2.scriptId, 7);
    assert.equal(bp2.line, 12);
    assert.equal(bp2.scopeId, 0);
    assert.equal(bp2.lib, -1);

    const bps = (session.sentResponses[0].body as DebugProtocol.SetBreakpointsResponse['body'])
        .breakpoints;
    assert.equal(bps[0].verified, true);
    assert.equal(bps[1].verified, true);
});

test('WinCCDebugSession: continueRequest sends "cont" command', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    const response = makeResponse<DebugProtocol.ContinueResponse>('continue');
    session.continueRequest(response, { threadId: 1 });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('cont'));
    assert.equal(session.sentResponses.length, 1);
    assert.equal(
        (session.sentResponses[0].body as DebugProtocol.ContinueResponse['body'])
            .allThreadsContinued,
        true,
    );
});

test('WinCCDebugSession: nextRequest sends "step over" command', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    const response = makeResponse<DebugProtocol.NextResponse>('next');
    session.nextRequest(response, { threadId: 1, granularity: 'statement' });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('step over'));
    assert.equal(session.sentResponses.length, 1);
});

test('WinCCDebugSession: stepInRequest sends "step in" command', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    const response = makeResponse<DebugProtocol.StepInResponse>('stepIn');
    session.stepInRequest(response, { threadId: 1, granularity: 'statement' });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('step in'));
    assert.equal(session.sentResponses.length, 1);
});

test('WinCCDebugSession: stepOutRequest sends "step out" command', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    const response = makeResponse<DebugProtocol.StepOutResponse>('stepOut');
    session.stepOutRequest(response, { threadId: 1, granularity: 'statement' });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('step out'));
    assert.equal(session.sentResponses.length, 1);
});

test('WinCCDebugSession: pauseRequest sends "b" command', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    const response = makeResponse<DebugProtocol.PauseResponse>('pause');
    session.pauseRequest(response, { threadId: 1 });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('b'));
    assert.equal(session.sentResponses.length, 1);
});

test('WinCCDebugSession: threadsRequest returns default thread (id=0) when no stopState', () => {
    const session = makeSession();
    const response = makeResponse<DebugProtocol.ThreadsResponse>('threads');

    session.threadsRequest(response);

    assert.equal(session.sentResponses.length, 1);
    const threads = (session.sentResponses[0].body as DebugProtocol.ThreadsResponse['body'])
        .threads;
    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, 0);
    assert.equal(threads[0].name, 'CTRL Manager');
});

test('WinCCDebugSession: threadsRequest returns thread id from stopState', () => {
    const session = makeSession();
    // Inject stopState as if a stop event was received for thread 0, script 2
    (session as any).stopState = { scriptId: 2, threadId: 0, scopeId: 0 };

    const response = makeResponse<DebugProtocol.ThreadsResponse>('threads');
    session.threadsRequest(response);

    const threads = (session.sentResponses[0].body as DebugProtocol.ThreadsResponse['body'])
        .threads;
    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, 0);
    assert.equal(threads[0].name, 'CTRL Manager');
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

test('WinCCDebugSession: variablesRequest sends "info thread" and parses JSON result', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.nextCommandResult = [
        'ThreadId: 0 (stopped) main',
        'local variables:',
        '{"const":0,"name":"i","value":{"type":"int","finalType":"int","value":5}}',
        '{"const":0,"name":"result","value":{"type":"int","finalType":"int","value":120}}',
    ];

    // First get a valid variablesReference via scopesRequest
    const scopesResp = makeResponse<DebugProtocol.ScopesResponse>('scopes');
    session.scopesRequest(scopesResp, { frameId: 0 });
    const varRef = (session.sentResponses[0].body as DebugProtocol.ScopesResponse['body'])
        .scopes[0].variablesReference;
    session.sentResponses = [];

    const response = makeResponse<DebugProtocol.VariablesResponse>('variables');
    session.variablesRequest(response, { variablesReference: varRef });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('info thread'));
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

    // WinCC OA 3.21 returns JSON variable object for print commands
    mock.nextCommandResult = [
        '{"const":0,"name":"myVar","value":{"type":"int","finalType":"int","value":42}}',
    ];

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
    // cleanupClient must resume CTRL and clear BPs before disconnecting
    assert.ok(mock.commands.includes('delete-all'), 'cleanup must send delete-all before disconnect');
    assert.ok(mock.commands.includes('cont'), 'cleanup must send cont to resume CTRL before disconnect');
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

    let infoScriptsCalled = false;
    let setBreakpointCmd = '';
    mock.sendCommand = async (cmd: string) => {
        mock.commands.push(cmd);
        if (cmd === 'info scripts') {
            infoScriptsCalled = true;
            // Return script entry with the basename that matches debugTest.ctl
            return ['ScriptId: 3; current thread: 0; scripts/debugTest.ctl'];
        }
        if (cmd.startsWith('breakpoint ')) {
            setBreakpointCmd = cmd;
            return ['breakpoint set'];
        }
        return ['OK'];
    };

    const response = makeResponse<DebugProtocol.SetBreakpointsResponse>('setBreakpoints');
    session.setBreakPointsRequest(response, {
        source: { path: '/home/dev/project/debugTest.ctl' },
        breakpoints: [{ line: 10 }],
    });
    await new Promise((r) => setImmediate(r));

    assert.ok(infoScriptsCalled, 'info scripts must be called to resolve scriptId');
    assert.ok(setBreakpointCmd.startsWith('breakpoint '), 'breakpoint command must be sent');
    const bp = JSON.parse(setBreakpointCmd.slice('breakpoint '.length));
    assert.equal(bp.scriptId, 3, 'scriptId must match');
    assert.equal(bp.line, 10, 'line number must match');
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

test('WinCCDebugSession: WinCC OA 3.21 stop format emits StoppedEvent and sets stopState', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    const attachResp = makeResponse<DebugProtocol.AttachResponse>('attach');
    session.attachRequest(attachResp, defaultAttachArgs);
    await new Promise((r) => setImmediate(r));
    session.sentEvents = [];

    // Simulate WinCC OA 3.21 stop event: "line: N" format with ScriptId/ScopeId/ThreadId
    mock.emit('message', [
        'line: 26',
        '/home/testus/proj/scripts/loop_test.ctl',
        'ScriptId: 3',
        'ScopeId: 0',
        'ThreadId: 2 (stopped) main',
    ]);
    await new Promise((r) => setImmediate(r));

    const stopEvent = session.sentEvents.find((e) => e.event === 'stopped');
    assert.ok(stopEvent, 'StoppedEvent must be emitted for WinCC OA 3.21 line: format');
    assert.equal((stopEvent as DebugProtocol.StoppedEvent).body.reason, 'breakpoint');
    assert.equal((stopEvent as DebugProtocol.StoppedEvent).body.threadId, 2);

    // stopState must capture scriptId and scopeId for subsequent bt/vars requests
    const stopState = (session as any).stopState as {
        scriptId: number;
        threadId: number;
        scopeId: number;
    };
    assert.ok(stopState, 'stopState must be set after stop event');
    assert.equal(stopState.scriptId, 3);
    assert.equal(stopState.threadId, 2);
    assert.equal(stopState.scopeId, 0);
});

test('WinCCDebugSession: stackTraceRequest sends script+thread context before bt', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;
    // Inject stopState as if a stop event was received for script 5, thread 1
    (session as any).stopState = { scriptId: 5, threadId: 1, scopeId: 0 };

    mock.sendCommand = async (cmd: string) => {
        mock.commands.push(cmd);
        if (cmd === 'bt') {
            return ['void main() at /path/loop_test.ctl:10'];
        }
        return ['OK'];
    };

    const response = makeResponse<DebugProtocol.StackTraceResponse>('stackTrace');
    session.stackTraceRequest(response, { threadId: 1 });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('script 5'), 'script N must be sent before bt');
    assert.ok(mock.commands.includes('thread 1'), 'thread N must be sent before bt');
    assert.ok(mock.commands.includes('bt'), 'bt must be sent to get call stack');
    // script N must precede thread N, which must precede bt
    const scriptIdx = mock.commands.indexOf('script 5');
    const threadIdx = mock.commands.indexOf('thread 1');
    const btIdx = mock.commands.indexOf('bt');
    assert.ok(scriptIdx < threadIdx, 'script N must come before thread N');
    assert.ok(threadIdx < btIdx, 'thread N must come before bt');

    const frames = (session.sentResponses[0].body as DebugProtocol.StackTraceResponse['body'])
        .stackFrames;
    assert.equal(frames.length, 1);
    assert.equal(frames[0].name, 'void main()');
    assert.equal(frames[0].line, 10);
});

test('WinCCDebugSession: variablesRequest sends script+thread context before info thread', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;
    (session as any).stopState = { scriptId: 2, threadId: 0, scopeId: 0 };

    mock.sendCommand = async (cmd: string) => {
        mock.commands.push(cmd);
        if (cmd === 'info thread') {
            return ['{"const":0,"name":"x","value":{"type":"int","finalType":"int","value":99}}'];
        }
        return ['OK'];
    };

    const scopesResp = makeResponse<DebugProtocol.ScopesResponse>('scopes');
    session.scopesRequest(scopesResp, { frameId: 0 });
    const varRef = (session.sentResponses[0].body as DebugProtocol.ScopesResponse['body'])
        .scopes[0].variablesReference;
    session.sentResponses = [];

    const response = makeResponse<DebugProtocol.VariablesResponse>('variables');
    session.variablesRequest(response, { variablesReference: varRef });
    await new Promise((r) => setImmediate(r));

    assert.ok(mock.commands.includes('script 2'), 'script N must be sent before info thread');
    assert.ok(mock.commands.includes('thread 0'), 'thread N must be sent before info thread');
    assert.ok(mock.commands.includes('info thread'), 'info thread must be sent for locals');
    const scriptIdx = mock.commands.indexOf('script 2');
    const threadIdx = mock.commands.indexOf('thread 0');
    const infoIdx = mock.commands.indexOf('info thread');
    assert.ok(scriptIdx < threadIdx);
    assert.ok(threadIdx < infoIdx);

    const vars = (session.sentResponses[0].body as DebugProtocol.VariablesResponse['body'])
        .variables;
    assert.equal(vars.length, 1);
    assert.equal(vars[0].name, 'x');
    assert.equal(vars[0].value, '99');
});
