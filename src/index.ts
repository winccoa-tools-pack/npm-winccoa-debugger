/**
 * WinCC OA Debug Adapter
 * 
 * Main entry point for the debug adapter package.
 * 
 * This package provides Debug Adapter Protocol (DAP) implementation for debugging
 * WinCC OA CTRL scripts from VS Code.
 * 
 * @packageDocumentation
 */

// Export adapter components
export * from './adapter/index.js';

// Export connection components
export * from './connection/index.js';

// Export protocol components
export * from './protocol/index.js';

// Export utilities
export * from './utils/index.js';

// Export types
export * from './types/index.js';

// Version
export const VERSION = '0.1.0';
