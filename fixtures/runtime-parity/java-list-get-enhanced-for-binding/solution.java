import java.util.*;
import java.util.stream.*;

class Solution {
  public int solve() {
    List<List<Integer>> graph = IntStream
      .range(0, 2)
      .mapToObj(ignored -> new ArrayList<Integer>())
      .collect(Collectors.toList());
    graph.get(0).add(1);
    int node = 0;
    int total = 0;
    for (int next : graph.get(node)) {
      total += next;
    }
    return total;
  }
}
