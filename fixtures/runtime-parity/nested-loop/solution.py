def solve(grid):
    total = 0
    for i in range(len(grid)):
        for j in range(len(grid[i])):
            total += grid[i][j]
    return total
