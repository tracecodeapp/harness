using System.Collections.Generic;

public class Solution {
  public List<int> solve() {
    var arr = new List<int> { 10, 20, 30 };
    var arr2 = new List<int> { 0, 2 };
    arr[arr2[1]] = 99;
    return arr;
  }
}
