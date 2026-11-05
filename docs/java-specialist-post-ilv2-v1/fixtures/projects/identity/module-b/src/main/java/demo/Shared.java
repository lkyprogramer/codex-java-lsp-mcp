package demo;
public class Shared {
    public String owner() { return "billing"; }
    public String select(int id) { return "billing:" + id; }
    public String select(String id) { return id; }
}
