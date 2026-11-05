package lab.pricing;

import java.math.BigDecimal;
public final class InvoiceLine {
  public final BigDecimal settledAmount;
  public InvoiceLine(BigDecimal settledAmount) { this.settledAmount=settledAmount; }
}
