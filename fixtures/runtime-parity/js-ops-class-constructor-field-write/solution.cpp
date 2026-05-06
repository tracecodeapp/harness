class NumArray {
  vector<int> prefix;
public:
  NumArray(vector<int>& nums) {
    tracecode::TraceHooks::setCurrentLine(5); tracecode::TraceHooks::emitPostLineFrame(5, "NumArray"); tracecode::emit_snapshot_value("nums", nums, 5); this->prefix = vector<int>{0};
  }

  int sumRange(int left, int right) {
    return this->prefix[0];
  }
};
