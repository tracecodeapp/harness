function solve(text: string): number {
  const counts = Array(26).fill(0);
  const base = 'a'.charCodeAt(0);
  for (let i = 0; i < text.length; i++) {
    counts[text.charCodeAt(i) - base] += 1;
  }
  return counts[0];
}
