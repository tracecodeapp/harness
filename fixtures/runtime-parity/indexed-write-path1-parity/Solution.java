import java.util.*;

class Solution {
  public int solve(int[] nums) {
    Map<Integer, Integer> freq = new HashMap<>();
    freq.put(1, 2);
    int left = nums[0];
    freq.put(left, freq.get(left) - 1);
    return freq.get(left);
  }
}
