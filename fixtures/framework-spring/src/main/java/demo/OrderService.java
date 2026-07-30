package demo;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
class OrderService {
  private final OrderRepository repository;
  private final ApplicationEventPublisher publisher;

  OrderService(OrderRepository repository, ApplicationEventPublisher publisher) {
    this.repository = repository;
    this.publisher = publisher;
  }

  @Transactional
  OrderResponse create(OrderRequest request) {
    Order order = repository.save(request.toOrder());
    publisher.publishEvent(new OrderCreated(order.id()));
    return OrderResponse.from(order);
  }
}
