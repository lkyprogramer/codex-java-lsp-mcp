package demo;
public class Shared {
    public String owner() { return "archive"; }
    public String select(int id) { return "archive:" + id; }
    public String select(String id) { return id; }
}
