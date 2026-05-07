import java.util.*;

class Solution {
  public int solve(int[] nums) {
    Map<Integer, Integer> freq = new HashMap<>();
    freq.put(1, freq.getOrDefault(1, 0) + 1);
    freq.put(2, freq.getOrDefault(2, 0) + 1);
    freq.put(1, freq.getOrDefault(1, 0) + 1);
    return freq.get(1);
  }
}
