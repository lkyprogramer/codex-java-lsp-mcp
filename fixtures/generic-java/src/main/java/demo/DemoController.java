package demo;

public class DemoController {
    private final DemoService demoService = new DemoService();
    public void saveDemo(DemoRequest request) {
        demoService.saveDemo(request);
    }
}
