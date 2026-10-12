"""tests/test_layout.py – grid geometry tests."""
import pytest


def gridDims(count):
    """Replicate JS gridDims in Python for testing."""
    import math
    PLANE_W, PLANE_H = 8, 6
    cols = math.ceil(math.sqrt(count * (PLANE_W / PLANE_H)))
    rows = math.ceil(count / cols)
    return cols, rows


def test_grid_1():
    cols, rows = gridDims(1)
    assert cols >= 1 and rows >= 1

def test_grid_covers_all(count=18):
    cols, rows = gridDims(count)
    assert cols * rows >= count

def test_grid_non_overlapping():
    """No two cells share the same (col, row) slot."""
    import math
    count = 30
    cols, _ = gridDims(count)
    positions = set()
    for i in range(count):
        col = i % cols
        row = i // cols
        assert (col, row) not in positions, f"Overlap at {col},{row}"
        positions.add((col, row))

def test_grid_aspect_ratio_reasonable():
    """Cols should roughly reflect the plane's aspect ratio (wider than tall)."""
    cols, rows = gridDims(20)
    assert cols >= rows  # more columns than rows for a wide plane
