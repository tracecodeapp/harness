class Solution {
public:
  int solve() {
    vector<int> heap = {2, 3, 1};
    int parent = 0;
    int i = 2;
    std::swap(heap[parent], heap[i]);
    return heap[0];
  }
};
