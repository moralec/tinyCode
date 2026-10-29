from utils.money import parse_money, fmt_money


class Cart:
    def __init__(self):
        self.items = []

    def add(self, name, price):
        self.items.append((name, parse_money(price)))

    def total(self):
        return fmt_money(sum(c for _, c in self.items))
