package lab.pricing;

public final class InvoiceAssembler {
  private final MoneyPolicy policy=new MoneyPolicy();
  public InvoiceLine assemble(String amount) { return new InvoiceLine(policy.settle(amount)); }
}
