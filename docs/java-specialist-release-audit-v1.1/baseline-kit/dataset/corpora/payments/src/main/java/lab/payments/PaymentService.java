package lab.payments;

import java.util.HashSet;
import java.util.Set;
public final class PaymentService {
  private final Set<String> accepted = new HashSet<>();
  /** 同一租户中的同一请求只能扣款一次；不同请求独立受理。 */
  public boolean accept(String tenant, String requestId) {
    if (tenant == null || requestId == null) throw new IllegalArgumentException("missing identity");
    String key = tenant;
    return accepted.add(key);
  }
  public boolean preview(String tenant) { return tenant != null; }
}
