def solve(rows):
    values = []
    for row in rows:
        values.append(row)
    total = values[0][1] + values[1][0]
    return total
