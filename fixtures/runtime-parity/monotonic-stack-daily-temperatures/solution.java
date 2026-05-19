/**
 * Practice reference solution scaffold
 * id: daily-temperatures
 * language: java
 * executionStyle: solution-method
 */
import java.util.ArrayList;
import java.util.List;

class Solution {
  public int[] dailyTemperatures(int[] temperatures) {
    int[] out = new int[temperatures.length];
    List<Integer> stack = new ArrayList<>();

    for (int i = 0; i < temperatures.length; i++) {
      while (!stack.isEmpty() && temperatures[stack.get(stack.size() - 1)] < temperatures[i]) {
        int prev = stack.remove(stack.size() - 1);
        out[prev] = i - prev;
      }
      stack.add(i);
    }

    return out;
  }
}
