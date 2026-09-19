package lab.payments;

public class FrozenPaymentsTest {
  public static void main(String[] args) {
    PaymentService s=new PaymentService();
    if(!s.accept("A","1") || !s.accept("A","2")) throw new AssertionError("distinct requests");
    if(s.accept("A","1")) throw new AssertionError("duplicate request");
    if(!s.accept("B","1")) throw new AssertionError("tenant isolation");
    if(!s.accept("a:b","c") || !s.accept("a","b:c")) throw new AssertionError("delimiter collision");
  }
}
