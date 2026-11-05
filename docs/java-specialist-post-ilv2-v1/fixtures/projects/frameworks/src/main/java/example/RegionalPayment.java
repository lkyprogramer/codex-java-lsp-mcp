package example;
import org.springframework.context.annotation.Profile;
@Profile("regional")
public class RegionalPayment implements PaymentRoute {
    public String route() { return "regional"; }
}
