function solve(grid) {
  const value = grid[0][1];
  grid[1][0] = value + grid[0][0];
  return grid;
}
