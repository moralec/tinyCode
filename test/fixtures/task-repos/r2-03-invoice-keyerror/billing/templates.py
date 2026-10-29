INVOICE = "Invoice {number}\nnet {net:.2f}\ntax {tax:.2f}\ngross {gross:.2f}\n"


def fill(template, **values):
    return template.format(**values)
