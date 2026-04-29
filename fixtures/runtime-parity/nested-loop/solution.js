function solve(grid) {
  let total = 0;
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      total += grid[i][j];
    }
  }
  return total;
}
