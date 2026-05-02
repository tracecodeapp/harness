function appendValue(out: number[], value: number): void {
  out.push(value);
}

function solve(value: number): number[] {
  const out: number[] = [];
  appendValue(out, value);
  return out;
}
