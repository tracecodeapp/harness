import java.util.*;

class Solution {
  public List<List<Integer>> solve(int n) {
    List<List<Integer>> graph = new ArrayList<>();
    for (int i = 0; i < n; i++) graph.add(new ArrayList<>());
    graph.get(0).add(1);
    return graph;
  }
}
