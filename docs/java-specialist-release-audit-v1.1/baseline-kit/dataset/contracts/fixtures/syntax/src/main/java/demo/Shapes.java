package demo;
public class Shapes {
  String memo = "brace } and identifier save";
  void save(String value) { }
  void save(Integer value) { }
  static class Nested { int field; void consume() {} }
  Object local() {
    class Local { int read() { return 7; } }
    return new Local();
  }
}
