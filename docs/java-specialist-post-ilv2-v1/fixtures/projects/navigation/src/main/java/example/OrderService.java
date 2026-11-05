package example;
/** 订单取消必须在发货之前，并归还先前预留的库存。 */
public class OrderService {
    private final StockLedger stock = new StockLedger();
    public boolean cancel(long orderId, boolean shipped) {
        if (shipped) return false;
        stock.release(orderId);
        return true;
    }
    public String cancelPreview(long orderId) {
        return "preview:" + orderId;
    }
    public void create(long orderId) {
        stock.reserve(orderId);
    }
    public String cancelNotice(long orderId) {
        return "notification:" + orderId;
    }
}
