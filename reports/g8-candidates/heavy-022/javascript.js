function checksum(rounds) {
  let state = 1;
  for (let i = 0; i < rounds; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
  }
  if (state !== 1413358465) throw new Error("Unexpected checksum");
  return state;
}
