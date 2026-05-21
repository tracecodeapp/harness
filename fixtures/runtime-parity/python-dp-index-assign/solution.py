def solve():
    dp = [5, 1, 2]
    num = 1
    j = 2
    dp[j] += dp[j - num]
    k = 1
    dp[k] = 0
    dp[k] = dp[k] or dp[k - num]
    return dp
