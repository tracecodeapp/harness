function fail() {
  throw new Error("bad input");
}

function solve(n) {
  try {
    fail();
  } catch (error) {
    return n;
  }
}
