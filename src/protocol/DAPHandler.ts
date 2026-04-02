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
     */
    public async setBreakpoint(
        location: string,
        condition?: string,
        temporary = false,
    ): Promise<void> {
        const cmd = CommandEncoder.encodeSetBreakpoint(location, condition, temporary);
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
     * Pause execution
     */
    public async pause(): Promise<void> {
        const cmd = CommandEncoder.encodePause();
        await this.datapointClient.sendCommand(cmd);
    }
}
