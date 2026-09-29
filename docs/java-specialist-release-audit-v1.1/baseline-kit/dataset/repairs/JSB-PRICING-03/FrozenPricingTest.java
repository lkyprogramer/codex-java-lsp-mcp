package lab.pricing;

public class FrozenPricingTest {
  public static void main(String[] args) {
    MoneyPolicy p=new MoneyPolicy();
    if(!"1.24".equals(p.settle("1.235").toPlainString()))throw new AssertionError("positive tie");
    if(!"-1.24".equals(p.settle("-1.235").toPlainString()))throw new AssertionError("negative tie");
    if(!"1.23".equals(p.settle("1.234").toPlainString()))throw new AssertionError("below tie");
    if(!"0.00".equals(p.settle("0").toPlainString()))throw new AssertionError("scale");
  }
}
