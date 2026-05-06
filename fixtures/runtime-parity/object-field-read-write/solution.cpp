struct Box {
  int value = 0;
};

class Solution {
public:
  int solve() {
    Box box;
    box.value = 7;
    return box.value;
  }
};
