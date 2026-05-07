import java.util.*;

class Solution {
  public int solve(int key) {
    Map<Integer, Integer>[] dp = new HashMap[]{new HashMap<>(), new HashMap<>()};
    dp[1].merge(key, 3, Integer::sum);
    return 1;
  }
}
