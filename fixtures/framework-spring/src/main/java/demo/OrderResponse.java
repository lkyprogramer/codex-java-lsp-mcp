package demo;

class OrderResponse {
  private final Long id;

  private OrderResponse(Long id) {
    this.id = id;
  }

  static OrderResponse from(Order order) {
    return new OrderResponse(order.id());
  }
}
