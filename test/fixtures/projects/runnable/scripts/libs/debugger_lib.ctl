// libs/debugger_lib.ctl — breakpoint target library for library-bp tests.
// Used by call_library_function.ctl via #uses "libs/debugger_lib".
// BP_LIB_LINE = 7  (int sum = a + b, first line of add_two_integers body)

int add_two_integers(int a, int b)
{
  int sum = a + b;   // line 7 — BP_LIB_LINE
  return sum;
}
