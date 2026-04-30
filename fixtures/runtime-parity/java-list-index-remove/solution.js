function solve(nums) {
  const values = [...nums];
  return values.splice(1, 1)[0];
}
