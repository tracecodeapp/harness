def solve(nums):
    buckets = {}
    if nums[0] not in buckets:
        buckets[nums[0]] = []
    buckets[nums[0]].append(nums[1])
    graph = [[] for _ in range(2)]
    graph[0].append(nums[2])
    return len(buckets[nums[0]]) + len(graph[0])
