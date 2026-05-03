using System.Collections.Generic;

public class Solution
{
    private List<List<int>> graph = new List<List<int>>();

    public List<List<int>> solve(int n)
    {
        this.graph = new List<List<int>>();
        for (int i = 0; i < n; i++)
        {
            this.graph.Add(new List<int>());
        }

        this.graph[0].Add(1);
        return this.graph;
    }
}
