package demo;
public record Modern(String id) {
  public Modern { if (id == null) throw new IllegalArgumentException(); }
  public String text() { return """
    braces { } in text block
    """; }
}
