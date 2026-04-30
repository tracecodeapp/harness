function solve(rows) {
  const values = [];
  for (const row of rows) {
    values.push(row);
  }
  const total = values[0][1] + values[1][0];
  return total;
}
