using System.Collections.Generic;

public class Solution
{
    public List<int> solve(int n)
    {
        var graph = new Dictionary<int, List<int>>();
        graph[0] = new List<int>();
        graph[0].Add(1);
        return graph[0];
    }
}
