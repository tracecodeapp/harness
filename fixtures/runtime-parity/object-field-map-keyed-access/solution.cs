using System.Collections.Generic;

public class Node
{
    public Dictionary<string, int> children = new Dictionary<string, int>();
}

public class Solution
{
    public int solve(string key)
    {
        var node = new Node();
        node.children[key] = 1;
        return node.children[key];
    }
}
