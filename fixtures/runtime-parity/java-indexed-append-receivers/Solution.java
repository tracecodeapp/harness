import java.util.*;

class Solution {
  public int solve(int[] nums) {
    Map<Integer, List<Integer>> buckets = new HashMap<>();
    if (!buckets.containsKey(nums[0])) {
      buckets.put(nums[0], new ArrayList<>());
    }
    buckets.get(nums[0]).add(nums[1]);
    List<Integer>[] graph = new ArrayList[2];
    for (int i = 0; i < graph.length; i++) graph[i] = new ArrayList<>();
    graph[0].add(nums[2]);
    return buckets.size() + graph[0].size();
  }
}
