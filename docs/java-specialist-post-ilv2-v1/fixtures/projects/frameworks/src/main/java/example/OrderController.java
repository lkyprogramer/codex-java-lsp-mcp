package example;
import org.springframework.web.bind.annotation.GetMapping;
/** 订单接口；注解在本语料中只用于声明形状，不启动Web容器。 */
public class OrderController {
    @GetMapping("/orders/cancelled")
    public String cancelledOrders() { return "cancelled"; }
    @GetMapping("/orders/active")
    public String activeOrders() { return "active"; }
}
