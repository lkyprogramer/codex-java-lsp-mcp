package example;
public class BindingDemo {
    public interface Handler { String handle(String value); }
    public static class ConsoleHandler implements Handler {
        public String handle(String value) { return "console:" + value; }
    }
    public String dispatch(Handler handler, String value) {
        return handler.handle(value);
    }
    public String direct(ConsoleHandler handler) {
        return handler.handle("direct");
    }
    public String choose(Number number) { return "number"; }
    public String choose(Integer number) { return "integer"; }
    public String selectNull() { return choose((Integer) null); }
    public String[] accept(String values[]) { return values; }
    public String join(String... values) { return String.join(",", values); }
}
