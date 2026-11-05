package example;
public class BindingControl {
 public static void main(String[] args) {
  BindingDemo demo = new BindingDemo();
  if (!"integer".equals(demo.selectNull())) throw new AssertionError("overload");
  BindingDemo.Handler h = new BindingDemo.ConsoleHandler();
  if (!"console:x".equals(demo.dispatch(h,"x"))) throw new AssertionError("dispatch");
  if (demo.accept(new String[]{"x"}).length != 1) throw new AssertionError("array");
  if (!"a,b".equals(demo.join("a","b"))) throw new AssertionError("varargs");
  System.out.println("JDK_CONTROL_NORMAL_RETURN");
 }
}
