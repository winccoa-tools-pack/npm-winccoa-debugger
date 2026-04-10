# Manual Test: Library Breakpoints

## Purpose

Verify that breakpoints set in `#uses` library files fire correctly when
debugging a WinCC OA CTRL script.

## Prerequisites

- WinCC OA 3.21 installed and project `runnable` available
- CTRL manager `-num 3` running `scripts/call_library_function.ctl`
  (contains `#uses "libs/debugger_lib"` and calls `add_two_integers()` in a loop)
- VS Code with the WinCC OA Debugger extension installed and built

## Test Steps

### 1. Start the Debug Session

1. Open VS Code in the project workspace.
2. Select the **WinCC OA Attach** launch configuration targeting CTRL manager 3.
3. Press **F5** (Start Debugging).
4. Verify the Debug toolbar appears and the session attaches successfully.

### 2. Set a Breakpoint in the Main Script

1. Open `scripts/call_library_function.ctl`.
2. Set a breakpoint at **line 14** (`result = add_two_integers(counter, 10);`).
3. Verify the breakpoint dot turns **solid red** (verified).
4. Wait for execution to stop at line 14 (the script loops, so it will hit
   this line within a few seconds).

### 3. Set a Breakpoint in the Library File

1. Open `scripts/libs/debugger_lib.ctl`.
2. Set a breakpoint at **line 7** (inside the `add_two_integers` function,
   e.g. `int sum = a + b;`).
3. Verify the breakpoint dot turns **solid red** (verified = true).
   - If the dot stays **grey/hollow**, the adapter failed to resolve the
     library via `info libs` — this is the bug scenario.

### 4. Continue and Verify Library Stop

1. Press **F5** (Continue) from the main script breakpoint.
2. Verify that execution stops at **line 7 in `debugger_lib.ctl`**.
3. Check the **Call Stack** panel: it should show the library function frame
   with the correct file path.
4. Hover over local variables (`a`, `b`) — they should display correct values.

### 5. Continue Again

1. Press **F5** (Continue).
2. Verify execution stops again at line 14 in the main script (the loop
   continues).
3. Press **F5** again — verify it stops at line 7 in the library again.

## Expected Results

| Step | Expected |
|------|----------|
| Main BP set | Verified (solid red dot) |
| Main BP hit | Execution stops at line 14 |
| Lib BP set | Verified (solid red dot) |
| Lib BP hit | Execution stops at line 7 in debugger_lib.ctl |
| Stack trace | Shows correct file path for library frame |
| Variables | Local variables visible in library scope |
| Continue cycle | Alternates between main (14) and lib (7) stops |

## What Changed (Technical Background)

The adapter previously used blind probing (`lib:0, lib:1, … lib:7`) to
discover library indices. This was:
- **Incorrect**: It used the main script's `scriptId` instead of `-1`
- **Fragile**: WinCC OA assigns arbitrary numeric LibIds that don't necessarily
  match `#uses` order

The fix uses `info libs` to discover the real LibId for each loaded library,
then sets breakpoints with `scriptId: -1` and the correct LibId.
