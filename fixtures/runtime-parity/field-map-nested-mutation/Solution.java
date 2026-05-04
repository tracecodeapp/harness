import java.util.*;

class Bag {
  private Map<Integer, List<Integer>> graph;

  public Bag() {
    this.graph = new HashMap<>();
    this.graph.put(0, new ArrayList<>());
  }

  public List<Integer> add(int value) {
    this.graph.get(0).add(value);
    return this.graph.get(0);
  }
}
