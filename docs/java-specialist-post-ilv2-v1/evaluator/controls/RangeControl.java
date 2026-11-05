package example;
public class RangeControl {
 public static void main(String[] args) {
  LongWorkflow w=new LongWorkflow();
  if (w.apply(true)!=-1) throw new AssertionError("cancel");
  if (w.apply(false)!=533) throw new AssertionError("value "+w.apply(false));
  System.out.println("JDK_CONTROL_NORMAL_RETURN");
 }
}
