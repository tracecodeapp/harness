function fail(): number {
  throw new Error("bad input");
}

function solve(n: number): number {
  try {
    fail();
  } catch (error) {
    return n;
  }
}
