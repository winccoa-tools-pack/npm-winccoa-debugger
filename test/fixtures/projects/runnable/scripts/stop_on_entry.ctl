// stop_on_entry.ctl
// Test script for DebugBreak() / stop-on-entry integration tests.
// Manager -num 2   Mode: manual   Flags: -dbg CTRL_DEBUGBREAK
//
// Expected stop at DebugBreak() on line 20.
// (Without -dbg CTRL_DEBUGBREAK, DebugBreak() is a no-op.)
//
// Test flow:
//   1. Start manager -num 2 (manual — started by the test after connecting)
//   2. Script calls DebugBreak() immediately → WinCC OA writes stop event
//   3. Adapter connects with answerOnConnect=true → receives the queued event
//   4. Inspect locals: a=10, b=32
//   5. Continue → script computes result=42 and exits
//
// STOP_LINE = 20  (DebugBreak())

main()
{
  int a = 10;
  int b = 32;

  DebugBreak();           // line 20 — stop-on-entry point

  int result = a + b;     // result = 42
  DebugN("stop_on_entry: a=" + a + " b=" + b + " result=" + result);
}
