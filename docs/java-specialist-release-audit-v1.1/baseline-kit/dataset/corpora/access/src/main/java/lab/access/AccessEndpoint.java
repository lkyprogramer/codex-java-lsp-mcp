package lab.access;

public final class AccessEndpoint {
  public static final String ROUTE="/share/access";
  private final SignedAccessPolicy policy=new SignedAccessPolicy();
  public boolean check(long now, long expiresAt) { return policy.isAllowed(now, expiresAt); }
}
