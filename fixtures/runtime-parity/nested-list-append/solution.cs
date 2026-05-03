using System.Collections.Generic;

public class Solution
{
    public List<List<int>> solve(int n)
    {
        var graph = new List<List<int>>();
        for (int i = 0; i < n; i++)
        {
            graph.Add(new List<int>());
        }

        graph[0].Add(1);
        return graph;
    }
}
