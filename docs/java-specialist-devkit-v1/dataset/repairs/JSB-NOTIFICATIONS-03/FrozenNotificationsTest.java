package lab.notifications;

public class FrozenNotificationsTest {
  public static void main(String[] args) {
    DispatchBus b=new DispatchBus();Subscription a=new Subscription("a","mail"),c=new Subscription("c","mail");
    b.add(a);b.add(c);b.add(new Subscription("x","sms"));b.remove(a);
    if(b.recipients("mail")!=1||b.recipients("sms")!=1)throw new AssertionError("sibling removal");
    b.remove(a);if(b.recipients("mail")!=1)throw new AssertionError("replayed removal");
  }
}
