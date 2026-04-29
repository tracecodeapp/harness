def solve(nums):
    total = 0
    for i in range(len(nums)):
        if nums[i] < 0:
            continue
        if nums[i] == 0:
            break
        total += nums[i]
    return total
