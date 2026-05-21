def solve(nums):
    lo = 1
    mid = len(nums) // 2
    left, right = lo, mid + 1
    i = j = mid + 1
    return left * 1000 + right * 100 + i * 10 + j
