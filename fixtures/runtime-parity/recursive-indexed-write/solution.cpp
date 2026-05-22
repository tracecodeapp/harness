class Solution {
public:
  vector<int> solve() {
    vector<int> arr{10, 20, 30};
    vector<int> arr2{0, 2};
    arr[arr2[1]] = 99;
    return arr;
  }
};
