using System.Collections.Generic;

public class Counter
{
    public Dictionary<string, int> counts;

    public Counter()
    {
        this.counts = new Dictionary<string, int>();
    }

    public int bump(string key)
    {
        this.counts[key] = (this.counts.ContainsKey(key) ? this.counts[key] : 0) + 1;
        return this.counts[key];
    }

    public int read(string key)
    {
        return this.counts[key];
    }
}
