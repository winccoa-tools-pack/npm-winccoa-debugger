/**
 * Logger
 *
 * Logging utility for debug adapter.
 *
 * All output is gated behind INTERNAL_DEBUG. When false (production default),
 * no messages are written to console/stderr — avoiding pollution of WinCC OA
 * node manager log files.
 */

/** Keep false in production to suppress all Logger output from WinCC OA logs. */
const INTERNAL_DEBUG = false;

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
        if (INTERNAL_DEBUG && this.level >= LogLevel.ERROR) {
            console.error(`${this.prefix} ERROR:`, message, ...args);
        }
    }

    public warn(message: string, ...args: any[]): void {
        if (INTERNAL_DEBUG && this.level >= LogLevel.WARN) {
            console.warn(`${this.prefix} WARN:`, message, ...args);
        }
    }

    public info(message: string, ...args: any[]): void {
        if (INTERNAL_DEBUG && this.level >= LogLevel.INFO) {
            console.log(`${this.prefix} INFO:`, message, ...args);
        }
    }

    public debug(message: string, ...args: any[]): void {
        if (INTERNAL_DEBUG && this.level >= LogLevel.DEBUG) {
            console.log(`${this.prefix} DEBUG:`, message, ...args);
        }
    }

    public trace(message: string, ...args: any[]): void {
        if (INTERNAL_DEBUG && this.level >= LogLevel.TRACE) {
            console.log(`${this.prefix} TRACE:`, message, ...args);
        }
    }
}

export const logger = Logger.getInstance();
