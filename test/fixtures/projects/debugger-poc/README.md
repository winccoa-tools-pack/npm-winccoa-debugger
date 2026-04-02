# WinCC OA Debugger POC Test Project

Minimal WinCC OA project for testing the debug adapter.

## Setup

- CTRL Manager (WCCOActrl) with debug enabled
- Simple test script that can be debugged
- _CtrlDebug_Ctrl_1 datapoint for communication

## Usage

This project is used by integration tests to validate:

- DatapointClient connection to _CtrlDebug_Ctrl_1
- Command encoding/decoding
- Breakpoint handling
- Step operations
- Variable inspection
