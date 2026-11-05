package demo;
class Parent { String value() { return "parent"; } }
class Child extends Parent { String value() { return "child"; } }
public class Selector {
  String call(Parent input) { return input.value(); }
  String choose(String s) { return "string"; }
  String choose(Integer i) { return "integer"; }
}
