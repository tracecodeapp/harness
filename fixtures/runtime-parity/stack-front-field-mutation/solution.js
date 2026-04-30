function solve(value) {
  const stack = [];
  stack.push({ items: [] });
  stack[stack.length - 1].items.push(value);
  return 1;
}
