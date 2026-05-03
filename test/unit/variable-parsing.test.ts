/**
 * variable-parsing.test.ts
 *
 * Unit tests for variable parsing of all WinCC OA CTRL data types.
 *
 * Tests the complete pipeline:
 *   WinCC OA "info thread" JSON line → parseVariables → DAP Variable[]
 *
 * TDD spec — these tests define the REQUIRED behaviour for parseVariables.
 * They will be RED until the implementation correctly handles all types.
 *
 * WinCC OA 3.21 "info thread" JSON format (one JSON object per line):
 * Primitive:  {"const":0,"name":"vi","value":{"type":"int","varType":327680,"finalType":"int","value":42}}
 *   dyn_int:    {"const":0,"name":"vdi","value":{"type":"dyn_int","varType":983040,"finalType":"dyn_int",
 *                "value":[{"type":"int","varType":327680,"finalType":"int","value":10},...]}}
 *   dyn_dyn:    {"const":0,"name":"vddi","value":{"type":"dyn_dyn_int","varType":1835008,"finalType":"dyn_dyn_int",
 *                "value":[{"type":"dyn_int","value":[...]},...]}} 
 *   mapping:    {"const":0,"name":"vm","value":{"type":"mapping","varType":3801088,"finalType":"mapping",
 *                "value":[{"key":"k","val":{"type":"string","value":"v"}},...]}}
 *   anytype:    {"const":0,"name":"vany","value":{"type":"anytype","finalType":"int","value":42}}
 *
 * Display spec:
 *   Primitives → plain string (no expansion)
 *   dyn_*      → "[<length>]" with indexed children expansion
 *   dyn_dyn_*  → "[<outerLen>]" with each child being an inner dyn (expandable)
 *   mapping    → "{<keyCount>}" with named children expansion
 *   anytype    → plain string of inner value (no expansion)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
    WinCCDebugSession,
    AttachRequestArguments,
} from '../../src/adapter/WinCCDebugSession.js';
import { DatapointClient, DatapointConfig } from '../../src/connection/DatapointClient.js';
import { DebugProtocol } from '@vscode/debugprotocol';

// ---------------------------------------------------------------------------
// Minimal MockDatapointClient (same structure as WinCCDebugSession.test.ts)
// ---------------------------------------------------------------------------

class MockDatapointClient extends EventEmitter {
    public connected = false;
    /** Queue of per-command responses. Each call shifts one entry; falls back to 'OK'. */
    public commandQueue: string[][] = [];
    public commands: string[] = [];

    private readonly dp: string;

    constructor(config: DatapointConfig) {
        super();
        const prefix = config.managerType ?? 'CTRL';
        this.dp = `_CtrlDebug_${prefix}_${config.managerNumber}`;
    }

    async connect(): Promise<void> { this.connected = true; this.emit('connected'); }
    async disconnect(): Promise<void> { this.connected = false; this.emit('disconnected'); }
    isConnected(): boolean { return this.connected; }
    getDebugDp(): string { return this.dp; }

    async sendCommand(cmd: string): Promise<string[]> {
        this.commands.push(cmd);
        if (this.commandQueue.length > 0) {
            return this.commandQueue.shift()!;
        }
        return ['OK'];
    }
}

// ---------------------------------------------------------------------------
// TestWinCCDebugSession — exposes protected/private methods via (session as any)
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
        if (this.mockClient) return this.mockClient as unknown as DatapointClient;
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

const defaultAttachArgs: AttachRequestArguments = {
    system: 'System1',
    host: 'localhost',
    port: 4999,
    manager: { type: 'CTRL', number: 1 },
};

function makeSession(mockClient?: MockDatapointClient): TestWinCCDebugSession {
    return new TestWinCCDebugSession(mockClient);
}

function makeResponse<T extends DebugProtocol.Response>(command: string): T {
    return {
        seq: 1, type: 'response', request_seq: 1,
        success: true, command, body: {},
    } as unknown as T;
}

/**
 * Helper: obtain a valid variablesReference (Locals scope) via scopesRequest.
 */
function getLocalsRef(session: TestWinCCDebugSession): number {
    const scopesResp = makeResponse<DebugProtocol.ScopesResponse>('scopes');
    session.scopesRequest(scopesResp, { frameId: 0 });
    const varRef = (session.sentResponses[0].body as DebugProtocol.ScopesResponse['body'])
        .scopes[0].variablesReference;
    session.sentResponses = [];
    return varRef;
}

/**
 * Helper: call variablesRequest and return the resulting Variable[].
 * The mock commandQueue entry at position 0 must be the "info thread" response.
 */
async function getVariables(
    session: TestWinCCDebugSession,
    ref: number,
): Promise<DebugProtocol.Variable[]> {
    const resp = makeResponse<DebugProtocol.VariablesResponse>('variables');
    session.variablesRequest(resp, { variablesReference: ref });
    await new Promise((r) => setImmediate(r));
    return (session.sentResponses[0].body as DebugProtocol.VariablesResponse['body']).variables;
}

// ---------------------------------------------------------------------------
// ── Primitive types ─────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

test('variable-parsing: int — displays raw value, not expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vi","value":{"type":"int","finalType":"int","value":42}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars.length, 1);
    assert.equal(vars[0].name, 'vi');
    assert.equal(vars[0].value, '42');
    assert.equal(vars[0].variablesReference, 0, 'int must not be expandable');
});

test('variable-parsing: uint — displays raw value, not expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vui","value":{"type":"uint","finalType":"uint","value":100}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].name, 'vui');
    assert.equal(vars[0].value, '100');
    assert.equal(vars[0].variablesReference, 0);
});

test('variable-parsing: float — displays raw value, not expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vf","value":{"type":"float","finalType":"float","value":3.14}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].name, 'vf');
    assert.equal(vars[0].value, '3.14');
    assert.equal(vars[0].variablesReference, 0);
});

test('variable-parsing: double — displays raw value, not expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vd","value":{"type":"double","finalType":"double","value":2.718}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].name, 'vd');
    assert.equal(vars[0].value, '2.718');
    assert.equal(vars[0].variablesReference, 0);
});

test('variable-parsing: bool true — displays "true", not expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vb","value":{"type":"bool","finalType":"bool","value":true}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].name, 'vb');
    assert.equal(vars[0].value, 'true');
    assert.equal(vars[0].variablesReference, 0);
});

test('variable-parsing: bool false — displays "false", not expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vb","value":{"type":"bool","finalType":"bool","value":false}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].value, 'false');
    assert.equal(vars[0].variablesReference, 0);
});

test('variable-parsing: string — displays quoted value, not expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vs","value":{"type":"string","finalType":"string","value":"hello"}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].name, 'vs');
    assert.equal(vars[0].value, '"hello"');
    assert.equal(vars[0].variablesReference, 0);
});

// ---------------------------------------------------------------------------
// ── dyn_int (1-D array) ─────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

test('variable-parsing: dyn_int — shows length, expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vdi","value":{"type":"dyn_int","varType":983040,"finalType":"dyn_int","value":[{"type":"int","varType":327680,"finalType":"int","value":10},{"type":"int","varType":327680,"finalType":"int","value":20},{"type":"int","varType":327680,"finalType":"int","value":30}]}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars.length, 1);
    assert.equal(vars[0].name, 'vdi');
    assert.equal(vars[0].value, '[3]', 'dyn_int value must show element count as "[3]"');
    assert.ok(vars[0].variablesReference > 0, 'dyn_int must be expandable (variablesReference > 0)');
    assert.equal(vars[0].indexedVariables, 3, 'indexedVariables must be 3');
});

test('variable-parsing: dyn_int children — indexed [0]=10, [1]=20, [2]=30', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vdi","value":{"type":"dyn_int","varType":983040,"finalType":"dyn_int","value":[{"type":"int","varType":327680,"finalType":"int","value":10},{"type":"int","varType":327680,"finalType":"int","value":20},{"type":"int","varType":327680,"finalType":"int","value":30}]}}',
    ]);
    const localsRef = getLocalsRef(session);
    const vars = await getVariables(session, localsRef);

    // Now request children of the dyn_int
    const dynRef = vars[0].variablesReference;
    session.sentResponses = [];
    const children = await getVariables(session, dynRef);

    assert.equal(children.length, 3);
    assert.equal(children[0].name, '[0]');
    assert.equal(children[0].value, '10');
    assert.equal(children[0].variablesReference, 0);
    assert.equal(children[1].name, '[1]');
    assert.equal(children[1].value, '20');
    assert.equal(children[2].name, '[2]');
    assert.equal(children[2].value, '30');
});

// ---------------------------------------------------------------------------
// ── dyn_string (1-D array of strings) ───────────────────────────────────────
// ---------------------------------------------------------------------------

test('variable-parsing: dyn_string — shows length, expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vds","value":{"type":"dyn_string","varType":1179648,"finalType":"dyn_string","value":[{"type":"string","varType":524288,"finalType":"string","value":"alpha"},{"type":"string","varType":524288,"finalType":"string","value":"beta"},{"type":"string","varType":524288,"finalType":"string","value":"gamma"}]}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].name, 'vds');
    assert.equal(vars[0].value, '[3]');
    assert.ok(vars[0].variablesReference > 0);
    assert.equal(vars[0].indexedVariables, 3);
});

test('variable-parsing: dyn_string children — strings are quoted', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vds","value":{"type":"dyn_string","varType":1179648,"finalType":"dyn_string","value":[{"type":"string","varType":524288,"finalType":"string","value":"alpha"},{"type":"string","varType":524288,"finalType":"string","value":"beta"},{"type":"string","varType":524288,"finalType":"string","value":"gamma"}]}}',
    ]);
    const localsRef = getLocalsRef(session);
    const vars = await getVariables(session, localsRef);

    session.sentResponses = [];
    const children = await getVariables(session, vars[0].variablesReference);

    assert.equal(children[0].name, '[0]');
    assert.equal(children[0].value, '"alpha"');
    assert.equal(children[1].value, '"beta"');
    assert.equal(children[2].value, '"gamma"');
});

// ---------------------------------------------------------------------------
// ── dyn_bool ─────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

test('variable-parsing: dyn_bool — shows length, children are true/false', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vdb","value":{"type":"dyn_bool","varType":917504,"finalType":"dyn_bool","value":[{"type":"bool","varType":262144,"finalType":"bool","value":true},{"type":"bool","varType":262144,"finalType":"bool","value":false},{"type":"bool","varType":262144,"finalType":"bool","value":true}]}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].value, '[3]');
    assert.ok(vars[0].variablesReference > 0);

    session.sentResponses = [];
    const children = await getVariables(session, vars[0].variablesReference);
    assert.equal(children[0].value, 'true');
    assert.equal(children[1].value, 'false');
    assert.equal(children[2].value, 'true');
});

// ---------------------------------------------------------------------------
// ── dyn_float ────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

test('variable-parsing: dyn_float — shows length, expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vdf","value":{"type":"dyn_float","varType":1114112,"finalType":"dyn_float","value":[{"type":"float","varType":458752,"finalType":"float","value":1.1},{"type":"float","varType":458752,"finalType":"float","value":2.2},{"type":"float","varType":458752,"finalType":"float","value":3.3}]}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].value, '[3]');
    assert.ok(vars[0].variablesReference > 0);
});

// ---------------------------------------------------------------------------
// ── dyn_dyn_int (2-D array) ──────────────────────────────────────────────────
// ---------------------------------------------------------------------------

test('variable-parsing: dyn_dyn_int — outer shows length, each child is expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vddi","value":{"type":"dyn_dyn_int","varType":1835008,"finalType":"dyn_dyn_int","value":[{"type":"dyn_int","varType":983040,"finalType":"dyn_int","value":[{"type":"int","varType":327680,"finalType":"int","value":1},{"type":"int","varType":327680,"finalType":"int","value":2}]},{"type":"dyn_int","varType":983040,"finalType":"dyn_int","value":[{"type":"int","varType":327680,"finalType":"int","value":3},{"type":"int","varType":327680,"finalType":"int","value":4}]}]}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].name, 'vddi');
    assert.equal(vars[0].value, '[2]', 'outer length must be 2');
    assert.ok(vars[0].variablesReference > 0, 'outer must be expandable');
    assert.equal(vars[0].indexedVariables, 2);
});

test('variable-parsing: dyn_dyn_int outer children are expandable inner rows', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vddi","value":{"type":"dyn_dyn_int","varType":1835008,"finalType":"dyn_dyn_int","value":[{"type":"dyn_int","varType":983040,"finalType":"dyn_int","value":[{"type":"int","varType":327680,"finalType":"int","value":1},{"type":"int","varType":327680,"finalType":"int","value":2}]},{"type":"dyn_int","varType":983040,"finalType":"dyn_int","value":[{"type":"int","varType":327680,"finalType":"int","value":3},{"type":"int","varType":327680,"finalType":"int","value":4}]}]}}',
    ]);
    const localsRef = getLocalsRef(session);
    const vars = await getVariables(session, localsRef);

    // Outer children
    session.sentResponses = [];
    const outerChildren = await getVariables(session, vars[0].variablesReference);

    assert.equal(outerChildren.length, 2);
    assert.equal(outerChildren[0].name, '[0]');
    assert.equal(outerChildren[0].value, '[2]', 'first row has 2 elements');
    assert.ok(outerChildren[0].variablesReference > 0, 'inner row must be expandable');
    assert.equal(outerChildren[1].name, '[1]');
    assert.equal(outerChildren[1].value, '[2]', 'second row has 2 elements');
    assert.ok(outerChildren[1].variablesReference > 0);
});

test('variable-parsing: dyn_dyn_int inner row children are not expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vddi","value":{"type":"dyn_dyn_int","varType":1835008,"finalType":"dyn_dyn_int","value":[{"type":"dyn_int","varType":983040,"finalType":"dyn_int","value":[{"type":"int","varType":327680,"finalType":"int","value":1},{"type":"int","varType":327680,"finalType":"int","value":2}]},{"type":"dyn_int","varType":983040,"finalType":"dyn_int","value":[{"type":"int","varType":327680,"finalType":"int","value":3},{"type":"int","varType":327680,"finalType":"int","value":4}]}]}}',
    ]);
    const localsRef = getLocalsRef(session);
    const vars = await getVariables(session, localsRef);

    session.sentResponses = [];
    const outerChildren = await getVariables(session, vars[0].variablesReference);

    session.sentResponses = [];
    const innerChildren = await getVariables(session, outerChildren[0].variablesReference);

    assert.equal(innerChildren.length, 2);
    assert.equal(innerChildren[0].name, '[0]');
    assert.equal(innerChildren[0].value, '1');
    assert.equal(innerChildren[0].variablesReference, 0);
    assert.equal(innerChildren[1].value, '2');
});

// ---------------------------------------------------------------------------
// ── dyn_dyn_string ──────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

test('variable-parsing: dyn_dyn_string — outer length, inner strings quoted', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vdds","value":{"type":"dyn_dyn_string","varType":2031616,"finalType":"dyn_dyn_string","value":[{"type":"dyn_string","varType":1179648,"finalType":"dyn_string","value":[{"type":"string","varType":524288,"finalType":"string","value":"aa"},{"type":"string","varType":524288,"finalType":"string","value":"bb"}]},{"type":"dyn_string","varType":1179648,"finalType":"dyn_string","value":[{"type":"string","varType":524288,"finalType":"string","value":"cc"},{"type":"string","varType":524288,"finalType":"string","value":"dd"}]}]}}',
    ]);
    const localsRef = getLocalsRef(session);
    const vars = await getVariables(session, localsRef);

    assert.equal(vars[0].value, '[2]');
    assert.ok(vars[0].variablesReference > 0);

    session.sentResponses = [];
    const outerChildren = await getVariables(session, vars[0].variablesReference);
    assert.equal(outerChildren[0].value, '[2]');

    session.sentResponses = [];
    const innerChildren = await getVariables(session, outerChildren[0].variablesReference);
    assert.equal(innerChildren[0].value, '"aa"');
    assert.equal(innerChildren[1].value, '"bb"');
});

// ---------------------------------------------------------------------------
// ── mapping ──────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

test('variable-parsing: mapping — shows key count, expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    // Real WinCC OA format: mapping is an array of {key, val} objects
    mock.commandQueue.push([
        '{"const":0,"name":"vm","value":{"type":"mapping","varType":3801088,"finalType":"mapping","value":[{"key":"num","val":{"type":"int","varType":327680,"finalType":"int","value":99}},{"key":"key1","val":{"type":"string","varType":524288,"finalType":"string","value":"value1"}}]}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].name, 'vm');
    assert.equal(vars[0].value, '{2}', 'mapping must show key count as "{2}"');
    assert.ok(vars[0].variablesReference > 0, 'mapping must be expandable');
    assert.equal(vars[0].namedVariables, 2, 'namedVariables must be 2');
});

test('variable-parsing: mapping children — key-value pairs', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vm","value":{"type":"mapping","varType":3801088,"finalType":"mapping","value":[{"key":"num","val":{"type":"int","varType":327680,"finalType":"int","value":99}},{"key":"key1","val":{"type":"string","varType":524288,"finalType":"string","value":"value1"}}]}}',
    ]);
    const localsRef = getLocalsRef(session);
    const vars = await getVariables(session, localsRef);

    session.sentResponses = [];
    const children = await getVariables(session, vars[0].variablesReference);

    assert.equal(children.length, 2);
    const key1 = children.find((c) => c.name === 'key1');
    const num  = children.find((c) => c.name === 'num');

    assert.ok(key1, '"key1" child must exist');
    assert.equal(key1!.value, '"value1"', 'string mapping values must be quoted');
    assert.equal(key1!.variablesReference, 0);

    assert.ok(num, '"num" child must exist');
    assert.equal(num!.value, '99');
    assert.equal(num!.variablesReference, 0);
});

// ---------------------------------------------------------------------------
// ── anytype ───────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

test('variable-parsing: anytype (int) — shows inner value with type annotation', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    // anytype: finalType tells us what is stored
    mock.commandQueue.push([
        '{"const":0,"name":"vany","value":{"type":"anytype","finalType":"int","value":42}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].name, 'vany');
    assert.equal(vars[0].value, '42');
    // anytype containing a scalar should not be expanded (no further commands needed)
    assert.equal(vars[0].variablesReference, 0);
});

test('variable-parsing: anytype (string) — shows quoted inner value', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vany","value":{"type":"anytype","finalType":"string","value":"test"}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].value, '"test"');
    assert.equal(vars[0].variablesReference, 0);
});

// ---------------------------------------------------------------------------
// ── Mixed: multiple variables in one info thread response ───────────────────
// ---------------------------------------------------------------------------

test('variable-parsing: mixed types in one response are all parsed correctly', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"vi","value":{"type":"int","varType":327680,"finalType":"int","value":42}}',
        '{"const":0,"name":"vs","value":{"type":"string","varType":524288,"finalType":"string","value":"hello"}}',
        '{"const":0,"name":"vdi","value":{"type":"dyn_int","varType":983040,"finalType":"dyn_int","value":[{"type":"int","varType":327680,"finalType":"int","value":10},{"type":"int","varType":327680,"finalType":"int","value":20},{"type":"int","varType":327680,"finalType":"int","value":30}]}}',
        '{"const":0,"name":"vm","value":{"type":"mapping","varType":3801088,"finalType":"mapping","value":[{"key":"num","val":{"type":"int","varType":327680,"finalType":"int","value":99}},{"key":"key1","val":{"type":"string","varType":524288,"finalType":"string","value":"value1"}}]}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars.length, 4);

    const vi   = vars.find((v) => v.name === 'vi')!;
    const vs   = vars.find((v) => v.name === 'vs')!;
    const vdi  = vars.find((v) => v.name === 'vdi')!;
    const vm   = vars.find((v) => v.name === 'vm')!;

    assert.equal(vi.value,  '42');
    assert.equal(vi.variablesReference, 0);

    assert.equal(vs.value,  '"hello"');
    assert.equal(vs.variablesReference, 0);

    assert.equal(vdi.value, '[3]');
    assert.ok(vdi.variablesReference > 0);

    assert.equal(vm.value,  '{2}');
    assert.ok(vm.variablesReference > 0);
});

// ---------------------------------------------------------------------------
// ── Edge cases ───────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

test('variable-parsing: empty dyn_int shows "[0]"', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([
        '{"const":0,"name":"empty","value":{"type":"dyn_int","varType":983040,"finalType":"dyn_int","value":[]}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].value, '[0]');
    // Empty array: variablesReference may be 0 (nothing to expand) — either is acceptable,
    // but if it is > 0, requesting it must return an empty list.
    if (vars[0].variablesReference > 0) {
        session.sentResponses = [];
        const children = await getVariables(session, vars[0].variablesReference);
        assert.equal(children.length, 0);
    }
});

test('variable-parsing: empty mapping shows "{0}"', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    // Real format: empty mapping is an empty array
    mock.commandQueue.push([
        '{"const":0,"name":"empty","value":{"type":"mapping","varType":3801088,"finalType":"mapping","value":[]}}',
    ]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars[0].value, '{0}');
});

// ─────────────────────────────────────────────────────────────────────────────────
// struct (user-defined type)
// ─────────────────────────────────────────────────────────────────────────────────

// Confirmed real WinCC OA 3.21 format for struct:
//   type = user-defined name (e.g. "MyStruct"), varType = 5570560
//   value = array of {const, name, value} objects (same shape as top-level variables)
const STRUCT_LINE = '{"const":0,"name":"vst","value":{"type":"MyStruct","varType":5570560,"finalType":"MyStruct","value":[{"const":0,"name":"x","value":{"type":"int","varType":327680,"finalType":"int","value":10}},{"const":0,"name":"label","value":{"type":"string","varType":524288,"finalType":"string","value":"test"}},{"const":0,"name":"active","value":{"type":"bool","varType":262144,"finalType":"bool","value":true}}]}}';

test('variable-parsing: struct — shows field count "{3}", is expandable', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    mock.commandQueue.push([STRUCT_LINE]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);

    assert.equal(vars.length, 1);
    assert.equal(vars[0].name, 'vst');
    assert.equal(vars[0].value, '{3}', 'struct with 3 fields must show "{3}"');
    assert.ok(vars[0].variablesReference > 0, 'struct must be expandable (variablesReference > 0)');
    assert.equal(vars[0].namedVariables, 3, 'struct must report 3 namedVariables');
});

test('variable-parsing: struct children — named fields with correct values', async () => {
    const mock = new MockDatapointClient(defaultAttachArgs as unknown as DatapointConfig);
    const session = makeSession(mock);
    await mock.connect();
    (session as any).client = mock;

    // First request: get the struct variable
    mock.commandQueue.push([STRUCT_LINE]);
    const ref = getLocalsRef(session);
    const vars = await getVariables(session, ref);
    const vst = vars[0];

    // Second request: expand struct children
    session.sentResponses = [];
    const children = await getVariables(session, vst.variablesReference);
    assert.equal(children.length, 3);

    const x      = children.find((c) => c.name === 'x');
    const label  = children.find((c) => c.name === 'label');
    const active = children.find((c) => c.name === 'active');

    assert.ok(x,      '"x" field must be present in struct children');
    assert.equal(x!.value, '10',      'int field x must display "10"');
    assert.equal(x!.variablesReference, 0, 'scalar field must not be expandable');

    assert.ok(label,  '"label" field must be present in struct children');
    assert.equal(label!.value, '"test"', 'string field label must be quoted');
    assert.equal(label!.variablesReference, 0);

    assert.ok(active, '"active" field must be present in struct children');
    assert.equal(active!.value, 'true',  'bool field active must display "true"');
    assert.equal(active!.variablesReference, 0);
});
