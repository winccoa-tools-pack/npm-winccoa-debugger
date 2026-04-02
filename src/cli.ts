#!/usr/bin/env node
/**
 * WinCC OA Debug Adapter CLI
 * 
 * Command-line interface for running the debug adapter as a standalone process.
 * This is used when VS Code communicates with the debug adapter via stdio or socket.
 * 
 * Usage:
 *   winccoa-debug-adapter [options]
 * 
 * Options:
 *   --server <port>     Listen on TCP port instead of stdio
 *   --log <level>       Set log level (error, warn, info, debug, trace)
 *   --help              Show this help message
 */

import { WinCCDebugSession } from './adapter/WinCCDebugSession.js';
import { LogLevel, logger } from './utils/Logger.js';

/**
 * Parse command line arguments
 */
function parseArgs(): {
  server?: number;
  logLevel: LogLevel;
  help: boolean;
} {
  const args = process.argv.slice(2);
  const result = {
    server: undefined as number | undefined,
    logLevel: LogLevel.INFO,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--server':
        result.server = parseInt(args[++i], 10);
        break;

      case '--log':
        const level = args[++i].toLowerCase();
        switch (level) {
          case 'error': result.logLevel = LogLevel.ERROR; break;
          case 'warn': result.logLevel = LogLevel.WARN; break;
          case 'info': result.logLevel = LogLevel.INFO; break;
          case 'debug': result.logLevel = LogLevel.DEBUG; break;
          case 'trace': result.logLevel = LogLevel.TRACE; break;
          default:
            console.error(`Unknown log level: ${level}`);
            process.exit(1);
        }
        break;

      case '--help':
      case '-h':
        result.help = true;
        break;

      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return result;
}

/**
 * Show help message
 */
function showHelp(): void {
  console.log(`
WinCC OA Debug Adapter

Usage:
  winccoa-debug-adapter [options]

Options:
  --server <port>     Listen on TCP port instead of stdio
  --log <level>       Set log level (error, warn, info, debug, trace)
  --help, -h          Show this help message

Examples:
  # Run with stdio (default for VS Code)
  winccoa-debug-adapter

  # Run on TCP port
  winccoa-debug-adapter --server 4711

  # Debug mode
  winccoa-debug-adapter --log debug
`);
}

/**
 * Main entry point
 */
function main(): void {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    return;
  }

  // Set log level
  logger.setLevel(args.logLevel);

  logger.info('Starting WinCC OA Debug Adapter');
  logger.info(`Log level: ${LogLevel[args.logLevel]}`);

  // Create debug session
  const session = new WinCCDebugSession();

  if (args.server !== undefined) {
    // Server mode (TCP)
    logger.info(`Listening on port ${args.server}`);
    session.start(process.stdin, process.stdout);
    // TODO: Implement TCP server mode
  } else {
    // Stdio mode (default)
    logger.info('Using stdio communication');
    session.start(process.stdin, process.stdout);
  }

  // Handle process signals
  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down');
    session.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down');
    session.shutdown();
    process.exit(0);
  });
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { main };
