package demospring;

class Order {
  private final Long id;

  Order(Long id) {
    this.id = id;
  }

  Long id() {
    return id;
  }
}
