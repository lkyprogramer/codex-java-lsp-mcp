package lab.notifications;

public final class NotificationEndpoint {
  private final DispatchBus bus;
  public NotificationEndpoint(DispatchBus bus) { this.bus=bus; }
  public int audience(String channel) { return bus.recipients(channel); }
}
