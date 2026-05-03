using System.Collections.Generic;

public class Box
{
    public List<int> items = new List<int>();
}

public class Solution
{
    public int solve(int value)
    {
        var stack = new List<Box>();
        stack.Add(new Box());
        stack[stack.Count - 1].items.Add(value);
        return 1;
    }
}
