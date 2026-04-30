function solve(value: number): number {
  const stack: Array<{ items: number[] }> = [];
  stack.push({ items: [] });
  stack[stack.length - 1].items.push(value);
  return 1;
}
