from utils import money
from utils.text import pad


def receipt(cart):
    lines = [pad(n, 12) + money.fmt_money(c) for n, c in cart.items]
    return "\n".join(lines + [pad("TOTAL", 12) + cart.total()])
