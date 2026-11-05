package lab.pagination;

public final class RetryPolicy {
  public boolean retry(int attempts) { return attempts < 3; }
  public long delay(int attempts) { return Math.min(1000L, 10L * attempts); }
}
