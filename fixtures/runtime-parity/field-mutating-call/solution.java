import java.util.*;

class Bag {
  private List<Integer> items;

  public Bag() {
    this.items = new ArrayList<>();
  }

  public int add(int value) {
    items.add(value);
    return items.size();
  }
}
