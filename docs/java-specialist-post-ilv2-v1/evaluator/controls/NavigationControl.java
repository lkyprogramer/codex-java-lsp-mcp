package example;
public class NavigationControl {
 public static void main(String[] args) {
  OrderService orders=new OrderService();
  if (orders.cancel(1,true)) throw new AssertionError("shipped");
  if (!orders.cancel(1,false)) throw new AssertionError("cancel");
  StockLedger stock=new StockLedger(); stock.reserve(2);
  if (!stock.contains(2)) throw new AssertionError("reserve");
  stock.release(2); if (stock.contains(2)) throw new AssertionError("release");
  System.out.println("JDK_CONTROL_NORMAL_RETURN");
 }
}
