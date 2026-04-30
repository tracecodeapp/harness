function solve(matrix: number[][], pizza: string[]): number {
  const cols: number = matrix[0].length;
  const width: number = pizza[0].length;
  return cols + width;
}
