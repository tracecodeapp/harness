import java.util.*;

class Box {
  List<Integer> items = new ArrayList<>();
}

class Solution {
  public int solve(int value) {
    Deque<Box> stack = new ArrayDeque<>();
    stack.push(new Box());
    stack.peek().items.add(value);
    return 1;
  }
}
