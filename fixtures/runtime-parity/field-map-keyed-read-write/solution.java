import java.util.*;

class Counter {
  private Map<String, Integer> counts;

  public Counter() {
    this.counts = new HashMap<>();
  }

  public int bump(String key) {
    this.counts.put(key, this.counts.getOrDefault(key, 0) + 1);
    return this.counts.get(key);
  }

  public int read(String key) {
    return this.counts.containsKey(key) ? this.counts.get(key) : 0;
  }
}
