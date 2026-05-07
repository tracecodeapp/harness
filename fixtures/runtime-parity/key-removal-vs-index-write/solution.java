import java.util.*;

class Solution {
  public int solve() {
    Map<String, Integer> counts = new HashMap<>(Map.of("a", 2, "b", 1));
    counts.put("a", counts.get("a") - 1);
    counts.remove("b");
    return counts.getOrDefault("a", 0) + counts.size();
  }
}
