import java.util.*;

class Solution {
  private List<List<Integer>> graph = new ArrayList<>();

  public List<List<Integer>> solve(int n) {
    this.graph = new ArrayList<>();
    for (int i = 0; i < n; i++) this.graph.add(new ArrayList<>());
    this.graph.get(0).add(1);
    return this.graph;
  }
}
