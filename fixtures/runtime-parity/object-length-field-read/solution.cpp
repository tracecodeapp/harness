struct Box {
  int length = 0;
};

class Solution {
public:
  int solve() {
    Box box;
    box.length = 4;
    return box.length;
  }
};
