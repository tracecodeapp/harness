import java.util.*;

class Solution {
  public List<Integer> solve() {
    Map<Integer, List<Integer>> graph = new HashMap<>();
    graph.put(0, new ArrayList<>());
    graph.get(0).add(1);
    return graph.values().iterator().next();
  }
}
