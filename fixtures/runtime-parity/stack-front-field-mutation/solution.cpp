struct Box {
  vector<int> items;
};

int solve(int value) {
  ::std::vector<Box> stack;
  stack.push_back(Box{});
  tracecode::write_trace_event_json("{\"kind\":\"mutate\",\"line\":6,\"target\":{\"variable\":\"stack\"},\"method\":\"append\"}", 6);
  tracecode::write_trace_event_json(std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(tracecode::current_trace_line()) + ",\"target\":{\"variable\":\"stack\"},\"value\":[]}", tracecode::current_trace_line()); tracecode::write_trace_event_json(std::string("{\"kind\":\"read\",\"line\":") + std::to_string(tracecode::current_trace_line()) + ",\"target\":{\"variable\":\"stack\",\"path\":[\"top\",\"items\"]},\"value\":[]}", tracecode::current_trace_line()); stack.back().items.push_back(value); tracecode::write_trace_event_json(std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(tracecode::current_trace_line()) + ",\"target\":{\"variable\":\"stack\",\"path\":[\"top\",\"items\"]},\"method\":\"append\"}", tracecode::current_trace_line());
  return 1;
}
