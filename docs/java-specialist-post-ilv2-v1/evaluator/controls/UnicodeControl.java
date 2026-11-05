package example;
public class UnicodeControl {
 public static void main(String[] args) {
  UnicodeService s=new UnicodeService();
  if (!"😀订单".equals(s.标题())) throw new AssertionError("unicode");
  if (!"已取消".equals(s.cancelledTitle())) throw new AssertionError("text");
  System.out.println("JDK_CONTROL_NORMAL_RETURN");
 }
}
