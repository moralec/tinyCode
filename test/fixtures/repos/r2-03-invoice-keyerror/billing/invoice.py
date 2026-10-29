from billing.pricing import breakdown
from billing.templates import INVOICE, fill


def render(number, lines, rate="standard"):
    return fill(INVOICE, number=number, **breakdown(lines, rate))
