struct Bucket {
  tracecode::Vector<int> keys;

  Bucket() : keys("bucket", "keys", 1) {}
};

int solve(int n) {
  unordered_map<int, vector<int>> graph;
  graph[0] = vector<int>();
  graph[0].push_back(1);
  Bucket bucket;
  tracecode::write_trace_event_json(std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(tracecode::current_trace_line()) + ",\"target\":{\"variable\":\"bucket\"},\"value\":{}}", tracecode::current_trace_line()); bucket.keys.push_back(2);
  return graph[0].size() + bucket.keys.size();
}
