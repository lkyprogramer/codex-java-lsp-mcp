package lab.notifications;

import java.util.ArrayList;
import java.util.List;
public final class DispatchBus {
  private final List<Subscription> subscriptions=new ArrayList<>();
  public void add(Subscription s) { subscriptions.add(s); }
  public int recipients(String channel) {
    int count=0;for(Subscription s:subscriptions)if(s.channel.equals(channel))count++;return count;
  }
  /** 取消指定订阅，不影响同频道其他订阅。 */
  public void remove(Subscription target) { subscriptions.removeIf(s -> s.channel.equals(target.channel)); }
}
