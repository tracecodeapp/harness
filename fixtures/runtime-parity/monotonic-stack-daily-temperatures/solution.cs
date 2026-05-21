/**
 * Practice reference solution scaffold
 * id: daily-temperatures
 * language: csharp
 * executionStyle: solution-method
 */
public class Solution
{
    public int[] DailyTemperatures(int[] temperatures)
    {
        int n = temperatures.Length;
        int[] out_ = new int[n];
        Stack<int> stack = new Stack<int>();

        for (int i = 0; i < n; i++)
        {
            while (stack.Count > 0 && temperatures[i] > temperatures[stack.Peek()])
            {
                int prev = stack.Pop();
                out_[prev] = i - prev;
            }
            stack.Push(i);
        }

        return out_;
    }

    public int[] dailyTemperatures(int[] temperatures)
    {
        return DailyTemperatures(temperatures);
    }
}
