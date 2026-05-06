int fail() {
  tracecode::write_trace_event_json("{\"kind\":\"exception\",\"line\":2,\"message\":\"bad input\"}", 2);
  return 0;
}

int solve(int n) {
  fail();
  return n;
}
