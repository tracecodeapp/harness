using System.Collections.Generic;

public class Solution
{
    public bool solve()
    {
        var adj = new Dictionary<char, HashSet<char>>();
        char c1 = 't';
        char c2 = 'f';
        adj[c1] = new HashSet<char>();

        if (!adj[c1].Contains(c2))
        {
            return true;
        }

        return false;
    }
}
