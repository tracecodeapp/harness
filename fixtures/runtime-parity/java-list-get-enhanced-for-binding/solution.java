import java.util.*;

class Solution {
  public int solve() {
    List<List<Integer>> graph = new ArrayList<>();
    graph.add(Arrays.asList(1, 2));
    int node = 0;
    int total = 0;
    for (int next : graph.get(node)) {
      total += next;
    }
    return total;
  }
}
