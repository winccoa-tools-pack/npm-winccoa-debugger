/**
 * ThreadManager
 *
 * Manages WinCC OA CTRL threads during debugging.
 *
 * Responsibilities:
 * - Track active threads
 * - Monitor thread states (RUNNING, STOPPED, STEP_IN, STEP_OUT, STEP_OVER)
 * - Handle thread selection and stack traces
 * - Convert WinCC OA thread info to DAP format
 *
 * WinCC OA Thread Info:
 * - ThreadId: unique identifier
 * - ScriptId/ScopeId: which script is running
 * - DebugState: current execution state
 * - Call Stack: function call hierarchy
 */

export interface WinCCThread {
    /** Thread ID */
    id: number;
    /** Thread name/description */
    name: string;
    /** Script ID */
    scriptId: number;
    /** Scope library ID (if applicable) */
    scopeId?: number;
    /** Current execution state */
    state: 'running' | 'stopped' | 'stepping';
    /** Current script location */
    location?: {
        source: string;
        line: number;
    };
}

export interface StackFrame {
    /** Stack frame ID */
    id: number;
    /** Function name */
    name: string;
    /** Source file */
    source: string;
    /** Line number */
    line: number;
    /** Column number */
    column: number;
}

export class ThreadManager {
    private threads: Map<number, WinCCThread> = new Map();
    private stoppedThreadId: number | undefined;

    constructor() {
        // TODO: Initialize thread manager
    }

    /**
     * Get all active threads
     */
    public async getThreads(): Promise<WinCCThread[]> {
        // TODO: Implement getThreads
        // Send "info threads" command to WinCC OA
        return Array.from(this.threads.values());
    }

    /**
     * Get stack trace for a thread
     */
    public async getStackTrace(threadId: number): Promise<StackFrame[]> {
        // TODO: Implement getStackTrace
        // Send "info stack" command to WinCC OA
        return [];
    }

    /**
     * Update thread information from WinCC OA
     */
    public updateThread(threadInfo: any): void {
        // TODO: Parse thread info from WinCC OA response
    }

    /**
     * Mark thread as stopped
     */
    public setThreadStopped(threadId: number, reason: 'breakpoint' | 'step' | 'pause'): void {
        this.stoppedThreadId = threadId;
        const thread = this.threads.get(threadId);
        if (thread) {
            thread.state = 'stopped';
        }
    }

    /**
     * Mark thread as running
     */
    public setThreadRunning(threadId: number): void {
        if (this.stoppedThreadId === threadId) {
            this.stoppedThreadId = undefined;
        }
        const thread = this.threads.get(threadId);
        if (thread) {
            thread.state = 'running';
        }
    }

    /**
     * Get currently stopped thread
     */
    public getStoppedThread(): number | undefined {
        return this.stoppedThreadId;
    }
}
