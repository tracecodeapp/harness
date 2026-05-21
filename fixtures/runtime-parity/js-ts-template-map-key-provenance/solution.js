function solve() {
  const rightIndex = new Map();
  const nr = 0;
  const nc = 1;
  rightIndex.set(`${nr},${nc}`, 7);
  return rightIndex.get(`${nr},${nc}`);
}
