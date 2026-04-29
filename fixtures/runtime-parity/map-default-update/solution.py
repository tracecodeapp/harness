def solve(nums):
    freq = {}
    freq[1] = freq.get(1, 0) + 1
    freq[2] = freq.get(2, 0) + 1
    freq[1] = freq.get(1, 0) + 1
    return freq[1]
