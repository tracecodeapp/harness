import java.util.*;

class Bucket {
  List<Integer> keys;
}

class Solution {
  public int solve(int n) {
    Map<Integer, List<Integer>> graph = new HashMap<>();
    graph.put(0, new ArrayList<>());
    graph.get(0).add(1);
    Bucket bucket = new Bucket();
    bucket.keys = new ArrayList<>();
    bucket.keys.add(2);
    return graph.get(0).size() + bucket.keys.size();
  }
}
