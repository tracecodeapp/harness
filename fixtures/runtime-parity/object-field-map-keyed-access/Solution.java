import java.util.*;

class Node {
  Map<String, Integer> children = new HashMap<>();
}

class Solution {
  public int solve(String key) {
    Node node = new Node();
    node.children.put(key, 1);
    return node.children.get(key);
  }
}
