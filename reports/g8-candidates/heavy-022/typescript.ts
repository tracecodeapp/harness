function checksum(rounds: number): number {
  let state = 1;
  for (let i = 0; i < rounds; i++) {
    state = (state * 1664525 + 1013904223) | 0;
  }
  if (state !== 80934913) throw new Error("Unexpected checksum");
  return state;
}
