function solve(board: string[]): number {
  let count = 0;
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) {
      if (board[r][c] === '.') {
        count += 1;
      }
    }
  }
  return count;
}
