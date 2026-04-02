/**
 * Logger
 *
 * Logging utility for debug adapter.
 *
 * Responsibilities:
 * - Log debug adapter operations
 * - Support different log levels
 * - Optional file logging
 * - Integration with VS Code output channel
 */

export enum LogLevel {
    ERROR = 0,
    WARN = 1,
    INFO = 2,
    DEBUG = 3,
    TRACE = 4,
}

export class Logger {
    private static instance: Logger;
    private level: LogLevel = LogLevel.INFO;
    private prefix = '[WinCC OA Debug]';

    private constructor() {}

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public setLevel(level: LogLevel): void {
        this.level = level;
    }

    public error(message: string, ...args: any[]): void {
        if (this.level >= LogLevel.ERROR) {
            console.error(`${this.prefix} ERROR:`, message, ...args);
        }
    }

    public warn(message: string, ...args: any[]): void {
        if (this.level >= LogLevel.WARN) {
            console.warn(`${this.prefix} WARN:`, message, ...args);
        }
    }

    public info(message: string, ...args: any[]): void {
        if (this.level >= LogLevel.INFO) {
            console.log(`${this.prefix} INFO:`, message, ...args);
        }
    }

    public debug(message: string, ...args: any[]): void {
        if (this.level >= LogLevel.DEBUG) {
            console.log(`${this.prefix} DEBUG:`, message, ...args);
        }
    }

    public trace(message: string, ...args: any[]): void {
        if (this.level >= LogLevel.TRACE) {
            console.log(`${this.prefix} TRACE:`, message, ...args);
        }
    }
}

export const logger = Logger.getInstance();
