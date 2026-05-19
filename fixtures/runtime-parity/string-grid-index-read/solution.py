def solve(board):
    count = 0
    for r in range(len(board)):
        for c in range(len(board[r])):
            if board[r][c] == '.':
                count += 1
    return count
