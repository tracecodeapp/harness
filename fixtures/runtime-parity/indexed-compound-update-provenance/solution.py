def solve():
    dp = [1, 0, 0]
    num = 1
    idx = 1
    dp[idx] += dp[idx - num]
    return dp[idx]
