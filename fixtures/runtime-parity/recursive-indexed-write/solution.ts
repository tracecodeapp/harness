function solve(): number[] {
  const arr: number[] = [10, 20, 30];
  const arr2: number[] = [0, 2];
  arr[arr2[1]] = 99;
  return arr;
}
