from billing.invoice import render
from billing.pricing import breakdown


def test_render():
    assert render(7, [(10.0, 2)]) == "Invoice 7\nnet 20.00\ntax 4.00\ngross 24.00\n"


def test_reduced():
    assert breakdown([(100.0, 1)], "reduced")["tax"] == 5.0
