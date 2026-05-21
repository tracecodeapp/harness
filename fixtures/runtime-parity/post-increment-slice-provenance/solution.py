def solve(nums):
    left = nums[:2]
    merged = [0, 0]
    i = 0
    k = 0
    pulled = left[i]
    i += 1
    merged[k] = pulled
    k += 1
    mid = 2
    tail = nums[mid:]
    head = nums[:mid]
    return merged[0] + tail[0] + head[0] + i + k
