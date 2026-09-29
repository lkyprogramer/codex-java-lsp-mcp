package lab.admissions;

public final class PreviewService {
  /** 展示层预览，不写回业务状态。 */
  public String preview(String value) { return value == null ? "" : value.trim(); }
}
