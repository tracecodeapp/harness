def count_placements(size):
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

    middle = size // 2
    total = 0
    for column in range(middle):
        bit = 1 << column
        total += 2 * visit(bit, bit << 1, bit >> 1)
    if size % 2:
        bit = 1 << middle
        total += visit(bit, bit << 1, bit >> 1)
    assert total == 14200
    return total
