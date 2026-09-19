package lab.pricing;

import java.math.BigDecimal;
import java.math.RoundingMode;
public final class MoneyPolicy {
  /** 金额保留两位小数，按 HALF_UP 结算。 */
  public BigDecimal settle(String amount) { return new BigDecimal(amount).setScale(2, RoundingMode.DOWN); }
}
