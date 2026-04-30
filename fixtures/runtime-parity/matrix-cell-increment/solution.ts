function solve(): number {
  const grid: number[][] = [[0, 0], [0, 0]];
  grid[1][0] += 1;
  return grid[1][0];
}
