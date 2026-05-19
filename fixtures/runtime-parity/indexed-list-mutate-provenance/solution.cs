using System.Collections.Generic;

public class Solution {
  public int Solve() {
    var graph = new List<List<int>> { new List<int>(), new List<int>() };
    var i = 1;
    var j = 7;
    graph[i].Add(j);
    return graph[i][0];
  }
}
