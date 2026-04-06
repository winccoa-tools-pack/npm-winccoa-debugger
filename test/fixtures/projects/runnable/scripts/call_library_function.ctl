// call_library_function.ctl
// Main script for library-breakpoint integration tests.
// Manager -num 3   Mode: always
// BP_MAIN_LINE = 13  (int sum = add_two_integers in while loop)

#uses "libs/debugger_lib"

main()
{
  int counter = 0;

  while (true)
  {
    int sum = add_two_integers(counter, 10);  // line 13 — BP_MAIN_LINE
    DebugN("call_library_function: sum = " + sum);
    counter++;
    delay(1);
  }
}
