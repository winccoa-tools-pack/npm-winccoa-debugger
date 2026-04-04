/**
 * DAPHandler
 *
 * Handles the translation between Debug Adapter Protocol (DAP) and WinCC OA commands.
 *
 * Responsibilities:
 * - Coordinate between DAP requests and WinCC OA commands
 * - Manage request/response correlation
 * - Handle protocol-level errors
 * - Provide high-level API for debug operations
 */

import { CommandEncoder } from './CommandEncoder.js';
import { ResponseParser, ThreadInfo, StackFrameInfo, VariableInfo } from './ResponseParser.js';
import { DatapointClient } from '../connection/index.js';

export class DAPHandler {
    private datapointClient: DatapointClient;

    constructor(datapointClient: DatapointClient) {
        this.datapointClient = datapointClient;
    }

    /**
     * Set breakpoint
     * @param scriptId  Script ID from "info scripts" response
     * @param line      1-based line number
     * @param scopeId   Scope ID (default 0)
     * @param lib       Library ID (default -1)
     */
    public async setBreakpoint(
        scriptId: number,
        line: number,
        scopeId = 0,
        lib = -1,
    ): Promise<void> {
        const cmd = CommandEncoder.encodeSetBreakpoint(scriptId, line, scopeId, lib);
        const response = await this.datapointClient.sendCommand(cmd);

        if (ResponseParser.isError(response)) {
            throw new Error(ResponseParser.getErrorMessage(response));
        }
    }

    /**
     * Clear all breakpoints
     */
    public async clearAllBreakpoints(): Promise<void> {
        const cmd = CommandEncoder.encodeDeleteAllBreakpoints();
        await this.datapointClient.sendCommand(cmd);
    }

    /**
     * Continue execution
     */
    public async continue(): Promise<void> {
        const cmd = CommandEncoder.encodeContinue();
        await this.datapointClient.sendCommand(cmd);
    }

    /**
     * Step in
     */
    public async stepIn(): Promise<void> {
        const cmd = CommandEncoder.encodeStepIn();
        await this.datapointClient.sendCommand(cmd);
    }

    /**
     * Step out
     */
    public async stepOut(): Promise<void> {
        const cmd = CommandEncoder.encodeStepOut();
        await this.datapointClient.sendCommand(cmd);
    }

    /**
     * Step over
     */
    public async stepOver(): Promise<void> {
        const cmd = CommandEncoder.encodeStepOver();
        await this.datapointClient.sendCommand(cmd);
    }

    /**
     * Get threads
     */
    public async getThreads(): Promise<ThreadInfo[]> {
        const cmd = CommandEncoder.encodeGetThreads();
        const response = await this.datapointClient.sendCommand(cmd);
        return ResponseParser.parseThreads(response);
    }

    /**
     * Get stack trace
     */
    public async getStackTrace(): Promise<StackFrameInfo[]> {
        const cmd = CommandEncoder.encodeGetStackTrace();
        const response = await this.datapointClient.sendCommand(cmd);
        return ResponseParser.parseStackTrace(response);
    }

    /**
     * Get local variables
     */
    public async getLocals(): Promise<VariableInfo[]> {
        const cmd = CommandEncoder.encodeGetLocals();
        const response = await this.datapointClient.sendCommand(cmd);
        return ResponseParser.parseVariables(response);
    }

    /**
     * Get global variables
     */
    public async getGlobals(): Promise<VariableInfo[]> {
        const cmd = CommandEncoder.encodeGetGlobals();
        const response = await this.datapointClient.sendCommand(cmd);
        return ResponseParser.parseVariables(response);
    }

    /**
     * Evaluate expression
     */
    public async evaluate(expression: string): Promise<{ result: string; type?: string }> {
        const cmd = CommandEncoder.encodeEvaluate(expression);
        const response = await this.datapointClient.sendCommand(cmd);
        return ResponseParser.parseEvaluateResult(response);
    }

    /**
     * Pause execution (interrupt running script).
     */
    public async pause(): Promise<void> {
        const cmd = CommandEncoder.encodePause();
        await this.datapointClient.sendCommand(cmd);
    }

    /**
     * Select script context. Must be called after a stop event, before
     * getStackTrace() / getLocals() / evaluate() / continue().
     * @param scriptId  Script ID from stop event
     */
    public async selectScript(scriptId: number): Promise<void> {
        const cmd = CommandEncoder.encodeSelectScript(scriptId);
        await this.datapointClient.sendCommand(cmd);
    }

    /**
     * Attach to stopped thread. Must be called after selectScript().
     * @param threadId  Thread ID from stop event
     */
    public async selectThread(threadId: number): Promise<void> {
        const cmd = CommandEncoder.encodeSelectThread(threadId);
        await this.datapointClient.sendCommand(cmd);
    }

    /**
     * Get list of loaded scripts with their ScriptIds.
     */
    public async getScripts(): Promise<string[]> {
        const cmd = CommandEncoder.encodeGetScripts();
        const response = await this.datapointClient.sendCommand(cmd);
        return response;
    }
}
