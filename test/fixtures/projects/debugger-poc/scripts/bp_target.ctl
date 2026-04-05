// bp_target.ctl
// Endless-loop target for breakpoint integration tests.
// Used by debugger-bp-cycle.test.ts — CTRL manager -num 2.
// BP_LINE = 11 (counter++ statement)

main()
{
  int counter = 0;
  DebugN("bp_target: starting");

  while (true)
  {
    counter++;
    DebugN("bp_target: counter = " + counter);
    delay(1);
  }
}
