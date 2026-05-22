using System;
using System.Collections.Generic;

public class Solution
{
    public int solve(List<List<object>> accounts)
    {
        var valueToOwners = new Dictionary<string, HashSet<string>>();
        foreach (var account in accounts)
        {
            object owner = account[0];
            string ownerText = Convert.ToString(owner) ?? "";
            for (int i = 1; i < account.Count; i++)
            {
                string value = Convert.ToString(account[i]) ?? "";
                if (!valueToOwners.ContainsKey(value))
                {
                    valueToOwners[value] = new HashSet<string>();
                }
                valueToOwners[value].Add(ownerText);
            }
        }
        return valueToOwners["a"].Count;
    }
}
