package lab.pagination;

import java.util.ArrayList;
import java.util.List;
public final class AuditTrail {
  private final List<String> events=new ArrayList<>();
  /** 只记录请求，不执行扣款、库存、过期或者权限判断。 */
  public void record(String requestId) { events.add(requestId); }
  public int count() { return events.size(); }
}
