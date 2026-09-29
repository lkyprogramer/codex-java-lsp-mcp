package lab.inventory;

public class FrozenInventoryTest {
  public static void main(String[] args) {
    StockService s=new StockService(10);Reservation r=s.reserve(3);
    if(s.available()!=7) throw new AssertionError("reserve");
    s.release(r);s.release(r);if(s.available()!=10) throw new AssertionError("idempotent release");
    Reservation x=s.reserve(2);s.release(x);if(s.available()!=10) throw new AssertionError("independent release");
    boolean rejected=false;try{s.reserve(0);}catch(IllegalArgumentException e){rejected=true;}
    if(!rejected) throw new AssertionError("validation regressed");
  }
}
