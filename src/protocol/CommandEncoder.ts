/**
 * CommandEncoder
 *
 * Encodes Debug Adapter Protocol (DAP) requests into WinCC OA debugger commands.
 *
 * WinCC OA Command Reference (verified by POC against WinCC OA 3.21):
 * - breakpoint {"scriptId":N,"scopeId":0,"lib":-1,"line":N}: Set breakpoint → "breakpoint set"
 * - delete-all: Remove all breakpoints → "all breakpoints deleted"
 * - cont: Continue execution → "continuing"  (NOT "c")
 * - b / break: Interrupt running script (pause)
 * - script <scriptId>: Select script context → "OK"  (required before thread)
 * - thread <threadId>: Attach to thread → "OK"  (required for locals/bt/print)
 * - bt: Get call stack (backtrace) → "void main() at file:line"
 * - info thread: Get locals of current thread → JSON variable entries
 * - info threads: List all threads
 * - info globals: Get global variables
 * - info scripts: List loaded scripts
 * - print <expr>: Evaluate expression → JSON variable entry
 * - step in / step out / step over: Step through code
 *
 * Stop event format (unsolicited result):
 * ["line: N", "/path/file.ctl", "ScriptId: N", "ScopeId: N", "ThreadId: N (stopped) main"]
 * Detection: result[0].startsWith("line: ")
 */

export class CommandEncoder {
    /**
     * Encode set breakpoint command.
     * @param scriptId  Script ID from "info scripts" response
     * @param line      1-based line number
     * @param scopeId   Scope ID (0 for main script)
     * @param lib       Library ID (-1 for no library)
     */
    public static encodeSetBreakpoint(
        scriptId: number,
        line: number,
        scopeId = 0,
        lib = -1,
    ): string {
        return `breakpoint ${JSON.stringify({ scriptId, scopeId, lib, line })}`;
    }

    /**
     * Encode delete all breakpoints command
     */
    public static encodeDeleteAllBreakpoints(): string {
        return 'delete-all';
    }

    /**
     * Encode continue command.
     */
    public static encodeContinue(): string {
        return 'cont';
    }

    /**
     * Encode step in command
     */
    public static encodeStepIn(): string {
        return 'step in';
    }

    /**
     * Encode step out command
     */
    public static encodeStepOut(): string {
        return 'step out';
    }

    /**
     * Encode step over command
     */
    public static encodeStepOver(): string {
        return 'step over';
    }

    /**
     * Encode get threads command
     */
    public static encodeGetThreads(): string {
        return 'info threads';
    }

    /**
     * Encode get stack trace command (backtrace).
     * Requires script + thread to be selected first.
     */
    public static encodeGetStackTrace(): string {
        return 'bt';
    }

    /**
     * Encode get local variables command.
     * Returns locals of the currently selected thread.
     * Requires script + thread to be selected first.
     */
    public static encodeGetLocals(): string {
        return 'info thread';
    }

    /**
     * Encode get global variables command
     */
    public static encodeGetGlobals(): string {
        return 'info globals';
    }

    /**
     * Encode evaluate expression command
     */
    public static encodeEvaluate(expression: string): string {
        return `print ${expression}`;
    }

    /**
     * Encode pause/interrupt command.
     * Sends "b" (break) to interrupt a running script.
     */
    public static encodePause(): string {
        return 'b';
    }

    /**
     * Encode select script context command.
     * Must be sent before thread() after a stop event.
     * @param scriptId  Script ID from stop event ("ScriptId: N")
     */
    public static encodeSelectScript(scriptId: number): string {
        return `script ${scriptId}`;
    }

    /**
     * Encode attach-to-thread command.
     * Must be sent after selectScript() before bt/info thread/print/cont.
     * @param threadId  Thread ID from stop event ("ThreadId: N ...")
     */
    public static encodeSelectThread(threadId: number): string {
        return `thread ${threadId}`;
    }

    /**
     * Encode get info scripts command.
     * Returns list of loaded scripts with ScriptId.
     */
    public static encodeGetScripts(): string {
        return 'info scripts';
    }

    /**
     * Encode JSON command (with ID)
     */
    public static encodeJsonCommand(id: string, cmd: string): string {
        return JSON.stringify({ id, cmd });
    }
}
