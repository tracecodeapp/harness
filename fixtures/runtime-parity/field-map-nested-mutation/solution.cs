using System.Collections.Generic;

public class Bag
{
    public Dictionary<int, List<int>> graph;

    public Bag()
    {
        this.graph = new Dictionary<int, List<int>>();
        this.graph[0] = new List<int>();
    }

    public List<int> add(int value)
    {
        this.graph[0].Add(value);
        return this.graph[0];
    }
}
