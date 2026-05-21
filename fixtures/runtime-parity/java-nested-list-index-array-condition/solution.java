/**
 * Runtime parity fixture
 * id: java-nested-list-index-array-condition
 * language: java
 * executionStyle: solution-method
 */
import java.util.ArrayList;
import java.util.List;

class Solution {
  public int countWarmer(int[] temperatures) {
    List<Integer> stack = new ArrayList<>();
    int warmer = 0;

    for (int i = 0; i < temperatures.length; i++) {
      while (!stack.isEmpty() && temperatures[stack.get(stack.size() - 1)] < temperatures[i]) {
        warmer++;
        stack.remove(stack.size() - 1);
      }
      stack.add(i);
    }

    return warmer;
  }
}
