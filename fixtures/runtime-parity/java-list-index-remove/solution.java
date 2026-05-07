import java.util.*;

class Solution {
  public int solve(int[] nums) {
    List<Integer> values = new ArrayList<>();
    for (int num : nums) values.add(num);
    return values.remove(1);
  }
}
