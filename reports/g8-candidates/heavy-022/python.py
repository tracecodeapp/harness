def count_placements(size, edge_columns):
    mask = (1 << size) - 1

    def visit(columns, left, right):
        if columns == mask:
            return 1
        available = mask & ~(columns | left | right)
        total = 0
        while available:
            bit = available & -available
            available ^= bit
            total += visit(columns | bit, (left | bit) << 1, (right | bit) >> 1)
        return total

    # Include the mirror of each of the selected edge starts.
    total = 0
    for column in range(edge_columns):
        bit = 1 << column
        total += 2 * visit(bit, bit << 1, bit >> 1)
    assert total == 2612
    return total
