package demo;

import java.util.List;
import java.util.Map;
import static java.util.Objects.requireNonNull;

@Deprecated
public sealed class ComplexJava<T extends Number>
    extends BaseType
    implements DemoPort
    permits ComplexJava.Child {

  private final DemoRepository repository;

  ComplexJava(DemoRepository repository) {
    this.repository = requireNonNull(repository);
  }

  Result packagePrivate(Command command) throws DomainException {
    String text = "{ this is not a block }";
    String json = """
        { "key": "value" }
        """;
    Helper helper = new Helper();
    return repository.save(command, helper);
  }

  public record Child(String id) implements DemoPort {}

  static class Helper {
    void run() {}
  }
}

class SecondTopLevel {
  void packagePrivateToo() {}
}
