package demospring;

import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
class OrderListener {
  @EventListener
  void on(OrderCreated event) {
  }
}
