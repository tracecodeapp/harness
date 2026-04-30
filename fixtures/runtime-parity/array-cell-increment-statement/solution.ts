function solve(grid: number[][]): number[][] {
  grid[0][1]++;
  --grid[1][0];
  return grid;
}
