package demo;

public class DemoControllerTest {
    public void saveDemo() {
        new DemoController().saveDemo(new DemoRequest("demo"));
    }
}
