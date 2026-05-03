using System.Collections.Generic;

public class Bag
{
    public List<int> items;

    public Bag()
    {
        this.items = new List<int>();
    }

    public List<int> add(int value)
    {
        this.items.Add(value);
        return this.items;
    }
}
