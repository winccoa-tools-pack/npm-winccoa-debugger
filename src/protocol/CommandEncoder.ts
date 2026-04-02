/**
 * CommandEncoder
 *
 * Encodes Debug Adapter Protocol (DAP) requests into WinCC OA debugger commands.
 *
 * Responsibilities:
 * - Convert DAP breakpoint requests to "break <location>" commands
 * - Encode step operations: "step in", "step out", "step over"
 * - Format variable inspection commands: "info locals", "info globals"
 * - Generate stack trace requests: "info stack"
 * - Create expression evaluation commands: "print <expr>"
 *
 * WinCC OA Command Reference:
 * - break <location>: Set breakpoint
 * - delete-all: Remove all breakpoints
 * - c / cont: Continue execution
 * - step [in|out|over]: Step through code
 * - info threads: List threads
 * - info stack: Get call stack
 * - info locals: Get local variables
 * - print <expr>: Evaluate expression
 */

export class CommandEncoder {
    /**
     * Encode set breakpoint command
     */
    public static encodeSetBreakpoint(
        location: string,
        condition?: string,
        temporary = false,
    ): string {
        // TODO: Implement breakpoint encoding
        // Format: break <location> [if <condition>] [temporary]
        let cmd = `break ${location}`;
        if (condition) {
            cmd += ` if ${condition}`;
        }
        if (temporary) {
            cmd += ` temporary`;
        }
        return cmd;
    }

    /**
     * Encode delete all breakpoints command
     */
    public static encodeDeleteAllBreakpoints(): string {
        return 'delete-all';
    }

    /**
     * Encode continue command
     */
    public static encodeContinue(): string {
        return 'c';
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
     * Encode get stack trace command
     */
    public static encodeGetStackTrace(): string {
        return 'info stack';
    }

    /**
     * Encode get local variables command
     */
    public static encodeGetLocals(): string {
        return 'info locals';
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
     * Encode pause command
     */
    public static encodePause(): string {
        return 'break';
    }

    /**
     * Encode JSON command (with ID)
     */
    public static encodeJsonCommand(id: string, cmd: string): string {
        return JSON.stringify({ id, cmd });
    }
}
