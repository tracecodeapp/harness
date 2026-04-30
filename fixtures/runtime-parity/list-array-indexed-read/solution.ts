function solve(rows: number[][]): number {
  const values: number[][] = [];
  for (const row of rows) {
    values.push(row);
  }
  const total = values[0][1] + values[1][0];
  return total;
}
