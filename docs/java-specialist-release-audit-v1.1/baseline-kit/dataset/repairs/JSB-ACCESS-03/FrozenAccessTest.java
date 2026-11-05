package lab.access;

public class FrozenAccessTest {
  public static void main(String[] args) {
    SignedAccessPolicy p=new SignedAccessPolicy();
    if(!p.isAllowed(99,100)) throw new AssertionError("before expiry");
    if(p.isAllowed(100,100)) throw new AssertionError("exact expiry");
    if(p.isAllowed(101,100)) throw new AssertionError("after expiry");
    if(p.isAllowed(Long.MAX_VALUE,Long.MAX_VALUE)) throw new AssertionError("max timestamp");
  }
}
