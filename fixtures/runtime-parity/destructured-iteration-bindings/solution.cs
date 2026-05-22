public class Solution {
  public int solve() {
    var prerequisites = new (int course, int prereq)[] { (1, 0), (2, 1) };
    int total = 0;
    foreach (var (course, prereq) in prerequisites) {
      total += course * 10 + prereq;
    }
    return total;
  }
}
