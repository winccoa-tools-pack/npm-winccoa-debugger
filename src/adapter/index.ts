/**
 * Debug Adapter Components
 * 
 * This module exports the main debug adapter components for WinCC OA debugging.
 */

export { WinCCDebugSession, LaunchRequestArguments, AttachRequestArguments } from './WinCCDebugSession.js';
export { BreakpointManager, WinCCBreakpoint } from './BreakpointManager.js';
export { ThreadManager, WinCCThread, StackFrame } from './ThreadManager.js';
export { VariableManager, Variable, Scope } from './VariableManager.js';
