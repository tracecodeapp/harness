using System.Collections.Generic;

public class Solution
{
    public void appendValue(List<int> outList, int value)
    {
        outList.Add(value);
    }

    public List<int> solve(int value)
    {
        var outList = new List<int>();
        appendValue(outList, value);
        return outList;
    }
}
