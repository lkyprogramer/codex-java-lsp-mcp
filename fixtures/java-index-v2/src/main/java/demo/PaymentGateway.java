package demo;

record PaymentCommand(String id) {}
record PaymentResult(boolean accepted) {}

interface PaymentGateway {
  PaymentResult pay(PaymentCommand command);
}

final class AliyunGateway implements PaymentGateway {
  @Override
  public PaymentResult pay(PaymentCommand command) {
    return new PaymentResult(true);
  }
}

final class PaymentService {
  private final PaymentGateway gateway;

  PaymentService(PaymentGateway gateway) {
    this.gateway = gateway;
  }

  PaymentResult pay(PaymentCommand command) {
    return gateway.pay(command);
  }

  void save(String value) {}

  void save(Long value) {}

  void ambiguousSave(Object value) {
    save(value);
  }
}
