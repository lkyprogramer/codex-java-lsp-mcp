package example;
import org.springframework.context.annotation.Profile;
@Profile("global")
public class GlobalPayment implements PaymentRoute {
    public String route() { return "global"; }
}
