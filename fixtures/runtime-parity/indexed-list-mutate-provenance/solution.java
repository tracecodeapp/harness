import java.util.*;

class Solution {
  public int solve() {
    List<List<Integer>> graph = new ArrayList<>();
    graph.add(new ArrayList<>());
    graph.add(new ArrayList<>());
    int i = 1;
    int j = 7;
    graph.get(i).add(j);
    return graph.get(i).get(0);
  }
}
