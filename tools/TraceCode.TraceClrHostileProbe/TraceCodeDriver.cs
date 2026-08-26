using System;

public static class TraceCodeDriver
{
    public static byte[] Run(byte[] input, Action onIteration)
    {
        if (input.Length != 1) throw new ArgumentException("Expected one control byte.", nameof(input));
        switch (input[0])
        {
            case 0:
                return new byte[] { 42 };
            case 1:
                throw new InvalidOperationException("intentional TraceCLR hostile probe failure");
            case 2:
                while (true)
                {
                    onIteration();
                }
            default:
                throw new ArgumentOutOfRangeException(nameof(input));
        }
    }
}
